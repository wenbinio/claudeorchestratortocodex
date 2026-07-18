#!/bin/sh

case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
        exit 0
        ;;
esac

block_merge() {
    printf '%s\n' \
        "Merge blocked for branch '$1' (verdict: $2). This hook gates only Claude's tool calls; the user's own terminal is unaffected. Path forward: apply the reviewer's fixes and re-run dispatch to re-review, or merge from your own terminal." \
        >&2
    exit 2
}

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

input_json=$(cat 2>/dev/null) || exit 0
command_text=$(
    printf '%s' "$input_json" | jq -er '
        if (.tool_input.command? | type) == "string" then
            .tool_input.command
        elif (.command? | type) == "string" then
            .command
        else
            empty
        end
    ' 2>/dev/null
) || exit 0

branches=$(
    printf '%s\n' "$command_text" | awk '
        function unwrap(value, first, last, quote) {
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            while (substr(value, 1, 1) == "(") {
                value = substr(value, 2)
            }
            while (substr(value, length(value), 1) == ")") {
                value = substr(value, 1, length(value) - 1)
            }

            if (length(value) >= 2) {
                first = substr(value, 1, 1)
                last = substr(value, length(value), 1)
                quote = sprintf("%c", 39)
                if ((first == "\"" && last == "\"") ||
                    (first == quote && last == quote)) {
                    value = substr(value, 2, length(value) - 2)
                }
            }

            while (substr(value, 1, 1) == "(") {
                value = substr(value, 2)
            }
            while (substr(value, length(value), 1) == ")") {
                value = substr(value, 1, length(value) - 1)
            }
            return value
        }

        {
            segment_count = split($0, segments, /[;&|]/)
            for (segment_index = 1; segment_index <= segment_count; segment_index++) {
                token_count = split(segments[segment_index], raw_tokens, /[[:space:]]+/)
                first_index = 0
                for (token_index = 1; token_index <= token_count; token_index++) {
                    tokens[token_index] = unwrap(raw_tokens[token_index])
                    if (first_index == 0 && tokens[token_index] != "") {
                        first_index = token_index
                    }
                }

                if (first_index == 0 || first_index + 1 > token_count ||
                    tolower(tokens[first_index]) != "git" ||
                    tolower(tokens[first_index + 1]) != "merge") {
                    continue
                }

                for (token_index = first_index + 2; token_index <= token_count; token_index++) {
                    candidate = tokens[token_index]
                    if (candidate ~ /^codex\/[A-Za-z0-9._\/-]+$/ && !seen[candidate]) {
                        print candidate
                        seen[candidate] = 1
                    }
                }
            }
        }
    ' 2>/dev/null
) || exit 0

[ -n "$branches" ] || exit 0

repo_key=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$repo_key" ] || exit 0
repo_key=$(printf '%s' "$repo_key" | tr '\\' '/') || exit 0

if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
    data_dir=$CLAUDE_PLUGIN_DATA
else
    [ -n "${HOME:-}" ] || exit 0
    # Marketplace installs may qualify the data-dir id; glob before assuming the bare name.
    data_dir=""
    for candidate in "$HOME"/.claude/plugins/data/*codex-fleet*/; do
        if [ -d "$candidate" ]; then
            data_dir=${candidate%/}
            break
        fi
    done
    [ -n "$data_dir" ] || data_dir=$HOME/.claude/plugins/data/codex-fleet
fi

approved_file=$data_dir/approved.json
[ -f "$approved_file" ] || exit 0

repo_present=$(
    jq -r --arg repo "$repo_key" '
        if type == "object" then has($repo) else false end
    ' "$approved_file" 2>/dev/null
) || exit 0
[ "$repo_present" = "true" ] || exit 0

repo_entry=$(jq -c --arg repo "$repo_key" '.[$repo]' "$approved_file" 2>/dev/null) || exit 0
repo_entry_type=$(printf '%s' "$repo_entry" | jq -r 'type' 2>/dev/null) || exit 0

while IFS= read -r branch; do
    [ -n "$branch" ] || continue

    if [ "$repo_entry_type" != "object" ]; then
        block_merge "$branch" malformed
    fi

    branch_present=$(
        printf '%s' "$repo_entry" | jq -r --arg branch "$branch" 'has($branch)' 2>/dev/null
    ) || exit 0
    if [ "$branch_present" != "true" ]; then
        block_merge "$branch" missing
    fi

    entry=$(
        printf '%s' "$repo_entry" | jq -c --arg branch "$branch" '.[$branch]' 2>/dev/null
    ) || exit 0
    entry_status=$(
        printf '%s' "$entry" | jq -r '
            if type == "object" and (.sha | type) == "string" then
                "ok"
            else
                "malformed"
            end
        ' 2>/dev/null
    ) || exit 0
    if [ "$entry_status" != "ok" ]; then
        block_merge "$branch" malformed
    fi

    recorded_sha=$(printf '%s' "$entry" | jq -r '.sha' 2>/dev/null) || exit 0
    case "$recorded_sha" in
        ''|*[!0-9A-Fa-f]*)
            block_merge "$branch" malformed
            ;;
    esac
    case ${#recorded_sha} in
        40|64)
            ;;
        *)
            block_merge "$branch" malformed
            ;;
    esac

    current_sha=$(git rev-parse "$branch" 2>/dev/null) || exit 0
    case "$current_sha" in
        ''|*[!0-9A-Fa-f]*)
            exit 0
            ;;
    esac
    case ${#current_sha} in
        40|64)
            ;;
        *)
            exit 0
            ;;
    esac

    recorded_sha_lower=$(printf '%s' "$recorded_sha" | tr '[:upper:]' '[:lower:]') || exit 0
    current_sha_lower=$(printf '%s' "$current_sha" | tr '[:upper:]' '[:lower:]') || exit 0
    if [ "$recorded_sha_lower" != "$current_sha_lower" ]; then
        # A7.8 block-on-stale: a RECORDED branch that changed since review is
        # stale/unreviewed — blocking closes the amend-one-commit bypass.
        block_merge "$branch" "stale (branch changed since review)"
    fi

    verdict_status=$(
        printf '%s' "$entry" | jq -r '
            if type == "object" and (.verdict | type) == "string" then
                "ok"
            else
                "malformed"
            end
        ' 2>/dev/null
    ) || exit 0
    if [ "$verdict_status" != "ok" ]; then
        block_merge "$branch" malformed
    fi

    verdict=$(printf '%s' "$entry" | jq -r '.verdict' 2>/dev/null) || exit 0
    case "$verdict" in
        approve)
            ;;
        needs_work|reject)
            block_merge "$branch" "$verdict"
            ;;
        *)
            block_merge "$branch" malformed
            ;;
    esac
done <<EOF
$branches
EOF

exit 0
