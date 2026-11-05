#!/usr/bin/env bash
# Regenerates data/ with jbr in a clone of comunica/Experiments-Centralized. Needs Docker.
# Not part of the normal pipeline: the generated files are committed (see data/README.md).
# Usage: scripts/generate-data.sh [watdiv-1|watdiv-10|bsbm-100|bsbm-1k|bsbm-10k|ldbc-snb-0.1 ...]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EC_DIR="${EC_DIR:-$ROOT/.cache/Experiments-Centralized}"
EC_COMMIT="ff983319cd70d47adaf73db18dc55145edb081ae"
BSBM_TEMPLATES="$ROOT/.cache/bsbm-templates"
# LDBC SNB is not on Experiments-Centralized master yet: it comes from comunica/Experiments-Centralized#7.
EC_LDBC_DIR="${EC_LDBC_DIR:-$ROOT/.cache/Experiments-Centralized-ldbc}"
EC_LDBC_REF="pull/7/head"
EC_LDBC_COMMIT="2f35846b30a2bca69206e7a55483fcafdebe02f8"
INSTANCES=5

if [ ! -d "$EC_DIR/.git" ]; then
  git clone https://github.com/comunica/Experiments-Centralized "$EC_DIR"
fi
git -C "$EC_DIR" checkout --quiet "$EC_COMMIT"

# Sets numeric/boolean fields of a jbr experiment template.
set_template() { # <experiment-dir> <key> <value> ...
  local dir="$1"; shift
  git -C "$dir" checkout --quiet -- jbr-experiment.json.template
  node -e '
    const fs = require("fs"); const file = process.argv[1];
    let t = fs.readFileSync(file, "utf8");
    for (let i = 2; i < process.argv.length; i += 2) {
      const re = new RegExp(`"${process.argv[i]}": [^,\\n]+`);
      if (!re.test(t)) throw new Error(`No ${process.argv[i]} in ${file}`);
      t = t.replace(re, `"${process.argv[i]}": ${process.argv[i + 1]}`);
    }
    fs.writeFileSync(file, t);' "$dir/jbr-experiment.json.template" "$@"
}

# Runs `jbr prepare` for combination 0 only (comunica-memory): all combinations share generated/,
# and preparing the other combinations would build Docker images of eight unrelated engines.
# jbr re-pulls the generator image on every prepare, which Docker Hub may rate-limit (HTTP 429): retry with backoff.
jbr_prepare() { # <experiment-dir>
  local dir="$1" delay=60
  (cd "$dir" && npm ci --no-audit --no-fund >/dev/null && npx jbr generate-combinations && mkdir -p generated)
  for attempt in 1 2 3 4 5 6; do
    if (cd "$dir" && npx jbr prepare -c 0 -f); then
      return 0
    fi
    echo "jbr prepare failed (attempt $attempt); retrying in ${delay}s" >&2
    sleep "$delay"; delay=$((delay * 2))
  done
  return 1
}

write_meta() { # <out-dir> <json>
  # Streamed with shell tools: datasets such as LDBC SNB exceed Node's maximum string length.
  local nt="$1/.dataset.nt" triples bytes sha
  triples="$(grep -cvE '^[[:space:]]*(#|$)' "$nt")"
  bytes="$(stat -c %s "$nt")"
  sha="$(sha256sum "$nt" | cut -d' ' -f1)"
  node -e '
    const fs = require("fs");
    const [out, extra, triples, ntBytes, ntSha256] = process.argv.slice(1);
    const meta = { ...JSON.parse(extra), triples: Number(triples), ntBytes: Number(ntBytes), ntSha256,
      queries: fs.readdirSync(`${out}/queries`).filter(f => f.endsWith(".sparql")).length };
    fs.writeFileSync(`${out}/generation.json`, JSON.stringify(meta, null, 2) + "\n");' "$1" "$2" "$triples" "$bytes" "$sha"
}

finish_dataset() { # <out-dir>
  local out="$1"
  gzip -9 -n -c "$out/.dataset.nt" > "$out/dataset.nt.gz"
  rm -f "$out/.dataset.nt"
}

gen_watdiv() { # <scale> <name>
  local scale="$1" name="$2" exp="$EC_DIR/experiments/watdiv" out="$ROOT/data/$2"
  set_template "$exp" datasetScale "$scale" queryCount "$INSTANCES" queryRecurrence 1 generateHdt false
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jbr_prepare "$exp"
  rm -rf "$out" && mkdir -p "$out/queries"
  cp "$exp/generated/dataset.nt" "$out/.dataset.nt"
  # WatDiv writes the instances of one template into one file, separated by blank lines.
  node -e '
    const fs = require("fs"); const [src, dst, n] = process.argv.slice(1);
    for (const f of fs.readdirSync(src).filter(f => f.endsWith(".txt")).sort()) {
      const qs = fs.readFileSync(`${src}/${f}`, "utf8").split(/\n\s*\n/).map(q => q.trim()).filter(Boolean);
      if (qs.length !== Number(n)) throw new Error(`${f}: expected ${n} instances, got ${qs.length}`);
      qs.forEach((q, i) => fs.writeFileSync(`${dst}/${f.replace(".txt", "")}-${i + 1}.sparql`, q + "\n"));
    }' "$exp/generated/queries" "$out/queries" "$INSTANCES"
  cp "$exp/output/logs/watdiv-generation.txt" "$out/generation-log.txt" 2>/dev/null \
    || cp "$exp/combinations/combination_0/output/logs/watdiv-generation.txt" "$out/generation-log.txt"
  write_meta "$out" "{\"generator\":\"watdiv\",\"scale\":$scale,\"instancesPerTemplate\":$INSTANCES,\"startedAt\":\"$started\",\"seed\":\"time-based (srand(time(NULL)) in WatDiv; not settable)\"}"
  finish_dataset "$out"
}

gen_bsbm() { # <productCount> <name>
  local products="$1" name="$2" exp="$EC_DIR/experiments/bsbm" out="$ROOT/data/$2"
  set_template "$exp" productCount "$products" generateHdt false
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jbr_prepare "$exp"
  if [ ! -d "$BSBM_TEMPLATES" ]; then
    mkdir -p "$BSBM_TEMPLATES"
    docker create --name bsbm-templates vcity/bsbm:v1.0 >/dev/null
    docker cp bsbm-templates:/app/queries/explore/. "$BSBM_TEMPLATES/"
    docker rm bsbm-templates >/dev/null
  fi
  rm -rf "$out" && mkdir -p "$out/queries"
  cp "$exp/generated/dataset.nt" "$out/.dataset.nt"
  node "$ROOT/scripts/capture-bsbm-queries.mjs" "$exp/generated" "$BSBM_TEMPLATES" "$out/queries" "$INSTANCES"
  cp "$exp/combinations/combination_0/output/logs/bsbm-generation.txt" "$out/generation-log.txt" 2>/dev/null \
    || cp "$exp/output/logs/bsbm-generation.txt" "$out/generation-log.txt" 2>/dev/null || true
  write_meta "$out" "{\"generator\":\"bsbm\",\"productCount\":$products,\"instancesPerTemplate\":$INSTANCES,\"startedAt\":\"$started\",\"seed\":\"generator: 53223436 (hard-coded in BSBM Generator.java); test driver: 9834533 (as in @jbr-experiment/bsbm)\"}"
  finish_dataset "$out"
}

gen_ldbc() { # <scale> <name>
  local scale="$1" name="$2" exp="$EC_LDBC_DIR/experiments/ldbc-snb" out="$ROOT/data/$2"
  if [ ! -d "$EC_LDBC_DIR/.git" ]; then
    git clone https://github.com/comunica/Experiments-Centralized "$EC_LDBC_DIR"
  fi
  git -C "$EC_LDBC_DIR" fetch --quiet origin "$EC_LDBC_REF"
  git -C "$EC_LDBC_DIR" checkout --quiet "$EC_LDBC_COMMIT"
  # Same settings as the experiment in that PR, except that no HDT file is needed here.
  set_template "$exp" scale "\"$scale\"" queryCount "$INSTANCES" querySeed 12345 generateHdt false
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  jbr_prepare "$exp"
  rm -rf "$out" && mkdir -p "$out/queries"
  cp "$exp/generated/dataset.nt" "$out/.dataset.nt"
  # interactive-short-N -> ISN, interactive-complex-N -> ICN; instances are separated by blank lines.
  node "$ROOT/scripts/split-ldbc-queries.mjs" "$exp/generated/queries" "$out/queries" "$INSTANCES"
  cp "$exp/output/logs/ldbc-snb-generation.txt" "$out/generation-log.txt" 2>/dev/null \
    || cp "$exp/combinations/combination_0/output/logs/ldbc-snb-generation.txt" "$out/generation-log.txt" 2>/dev/null || true
  write_meta "$out" "{\"generator\":\"ldbc-snb\",\"scale\":\"$scale\",\"instancesPerTemplate\":$INSTANCES,\"startedAt\":\"$started\",\"seed\":\"datagen: deterministic for a given params.ini; query parameters: 12345 (as in comunica/Experiments-Centralized#7)\"}"
  finish_dataset "$out"
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(watdiv-1 watdiv-10 bsbm-100 bsbm-1k)
for t in "${targets[@]}"; do
  echo "=== Generating $t"
  case "$t" in
    watdiv-1) gen_watdiv 1 "$t" ;;
    watdiv-10) gen_watdiv 10 "$t" ;;
    bsbm-100) gen_bsbm 100 "$t" ;;
    bsbm-1k) gen_bsbm 1000 "$t" ;;
    bsbm-10k) gen_bsbm 10000 "$t" ;;
    ldbc-snb-0.1) gen_ldbc 0.1 "$t" ;;
    *) echo "Unknown dataset $t" >&2; exit 1 ;;
  esac
done
