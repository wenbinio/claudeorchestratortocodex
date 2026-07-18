#!/bin/sh

# Advisory tripwire only: the dispatch/integration protocol is the enforcement
# layer. This hook is not a security boundary and must fail open on errors.

case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
        exit 0
        ;;
esac

block_merge() {
    printf '%s\n' \
        "Merge blocked for branch '$1' (verdict: $2). This advisory tripwire gates only Claude's tool calls; the user's own terminal is unaffected. Path forward: apply the reviewer's fixes and re-run dispatch to re-review, or merge from your own terminal." \
        >&2
    exit 2
}

resolve_data_dir() {
    if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
        printf '%s\n' "$CLAUDE_PLUGIN_DATA"
        return 0
    fi

    [ -n "${HOME:-}" ] || return 1
    # Marketplace installs may qualify the data-dir id. No match is an
    # infrastructure miss, so the advisory guard opens.
    for candidate in "$HOME"/.claude/plugins/data/*codex-fleet*/; do
        if [ -d "$candidate" ]; then
            printf '%s\n' "${candidate%/}"
            return 0
        fi
    done

    return 1
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

data_dir=$(resolve_data_dir) || exit 0
approved_file=$data_dir/approved.json
[ -f "$approved_file" ] || exit 0

hook_cwd=$(pwd -P 2>/dev/null) || exit 0
[ -n "$hook_cwd" ] || exit 0

check_merge() {
    target=$1
    branch=$2

    common_dir=$(git -C "$target" rev-parse --git-common-dir 2>/dev/null) || exit 0
    [ -n "$common_dir" ] || exit 0
    case $common_dir in
        /*) common_path=$common_dir ;;
        *) common_path=$target/$common_dir ;;
    esac
    repo_key=$(CDPATH= cd -P "$common_path" 2>/dev/null && pwd -P) || exit 0
    [ -n "$repo_key" ] || exit 0

    repo_present=$(
        jq -r --arg repo "$repo_key" '
            if type == "object" then has($repo) else false end
        ' "$approved_file" 2>/dev/null
    ) || exit 0
    [ "$repo_present" = "true" ] || return 0

    repo_entry=$(jq -c --arg repo "$repo_key" '.[$repo]' "$approved_file" 2>/dev/null) || exit 0
    repo_entry_type=$(printf '%s' "$repo_entry" | jq -r 'type' 2>/dev/null) || exit 0
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
    case $recorded_sha in
        ''|*[!0-9A-Fa-f]*) block_merge "$branch" malformed ;;
    esac
    case ${#recorded_sha} in
        40|64) ;;
        *) block_merge "$branch" malformed ;;
    esac

    current_sha=$(git -C "$target" rev-parse "$branch" 2>/dev/null) || exit 0
    case $current_sha in
        ''|*[!0-9A-Fa-f]*) exit 0 ;;
    esac
    case ${#current_sha} in
        40|64) ;;
        *) exit 0 ;;
    esac

    recorded_sha_lower=$(printf '%s' "$recorded_sha" | tr '[:upper:]' '[:lower:]') || exit 0
    current_sha_lower=$(printf '%s' "$current_sha" | tr '[:upper:]' '[:lower:]') || exit 0
    if [ "$recorded_sha_lower" != "$current_sha_lower" ]; then
        # A7.8 block-on-stale closes the amend-one-commit bypass.
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
    case $verdict in
        needs_work|reject)
            block_merge "$branch" "$verdict"
            ;;
        approve)
            ;;
        *)
            block_merge "$branch" malformed
            ;;
    esac

    eligible_status=$(
        printf '%s' "$entry" | jq -r '
            if type == "object" and (.eligible | type) == "boolean" then
                if .eligible then "eligible" else "ineligible" end
            else
                "malformed"
            end
        ' 2>/dev/null
    ) || exit 0
    case $eligible_status in
        eligible) ;;
        ineligible) block_merge "$branch" "ineligible (verification requirements not met)" ;;
        *) block_merge "$branch" malformed ;;
    esac
}

update_target() {
    current_target=$1
    next_path=$2
    if [ -z "$next_path" ]; then
        updated_target=$current_target
        return 0
    fi
    case $next_path in
        /*) updated_target=$next_path ;;
        *) updated_target=$current_target/$next_path ;;
    esac
}

reset_command_parser() {
    command_state=leader
    command_base=$hook_cwd
    git_target=$hook_cwd
    wrapper_value_state=
}

reset_command_segment() {
    reset_command_parser
}

run_nested_tokenizer() {
    nested_text=$1
    parent_validate_only=$validate_only
    (
        token_depth=$((token_depth + 1))
        [ "$token_depth" -le 4 ] || exit 0

        validate_only=1
        reset_command_parser
        tokenize "$nested_text" || exit 1
        [ "$parent_validate_only" = 0 ] || exit 0

        validate_only=0
        reset_command_parser
        tokenize "$nested_text"
    )
}

process_token() {
    parsed_token=$1

    case $command_state in
        ignore)
            return 0
            ;;
        leader)
            case $parsed_token in
                [A-Za-z_]*=*)
                    assignment_name=${parsed_token%%=*}
                    case $assignment_name in
                        *[!A-Za-z0-9_]*) ;;
                        *) return 0 ;;
                    esac
                    ;;
            esac

            command_name=${parsed_token##*/}
            case $command_name in
                git)
                    git_target=$command_base
                    command_state=git_global
                    ;;
                command)
                    command_state=wrapper_command
                    ;;
                exec)
                    command_state=wrapper_exec
                    ;;
                env)
                    command_state=wrapper_env
                    ;;
                sudo)
                    command_state=wrapper_sudo
                    ;;
                sh|bash|dash|zsh|ksh|powershell|powershell.exe|pwsh|pwsh.exe|cmd|cmd.exe)
                    wrapper_shell_name=$command_name
                    command_state=wrapper_shell
                    ;;
                eval)
                    command_state=wrapper_code
                    ;;
                *)
                    command_state=ignore
                    ;;
            esac
            ;;
        wrapper_command)
            case $parsed_token in
                -v|-V) command_state=ignore ;;
                -p|--) ;;
                *) command_state=leader; process_token "$parsed_token" ;;
            esac
            ;;
        wrapper_exec)
            case $parsed_token in
                --) ;;
                -a) command_state=wrapper_exec_value ;;
                -*) ;;
                *) command_state=leader; process_token "$parsed_token" ;;
            esac
            ;;
        wrapper_exec_value)
            command_state=wrapper_exec
            ;;
        wrapper_env)
            case $parsed_token in
                [A-Za-z_]*=*)
                    assignment_name=${parsed_token%%=*}
                    case $assignment_name in
                        *[!A-Za-z0-9_]*) command_state=leader; process_token "$parsed_token" ;;
                        *) ;;
                    esac
                    ;;
                --) command_state=leader ;;
                -u|--unset|-C|--chdir) command_state=wrapper_env_value ;;
                --unset=*|--chdir=*|-i|--ignore-environment|-0|--null) ;;
                -*) ;;
                *) command_state=leader; process_token "$parsed_token" ;;
            esac
            ;;
        wrapper_env_value)
            command_state=wrapper_env
            ;;
        wrapper_sudo)
            case $parsed_token in
                --) command_state=leader ;;
                -u|--user|-g|--group|-h|--host|-p|--prompt|-C|--close-from|-T|--command-timeout|-R|--chroot|-D|--chdir)
                    command_state=wrapper_sudo_value
                    ;;
                --user=*|--group=*|--host=*|--prompt=*|--close-from=*|--command-timeout=*|--chroot=*|--chdir=*) ;;
                -*) ;;
                *) command_state=leader; process_token "$parsed_token" ;;
            esac
            ;;
        wrapper_sudo_value)
            command_state=wrapper_sudo
            ;;
        wrapper_shell)
            case $wrapper_shell_name in
                sh|bash|dash|zsh|ksh)
                    case $parsed_token in
                        -c) command_state=wrapper_code ;;
                        -*) ;;
                        *) command_state=ignore ;;
                    esac
                    ;;
                powershell|powershell.exe|pwsh|pwsh.exe)
                    case $parsed_token in
                        -Command|-command|-C|-c) command_state=wrapper_code ;;
                        -*) ;;
                        *) command_state=ignore ;;
                    esac
                    ;;
                cmd|cmd.exe)
                    case $parsed_token in
                        /c|/C|/k|/K) command_state=wrapper_code ;;
                        *) ;;
                    esac
                    ;;
            esac
            ;;
        wrapper_code)
            command_state=ignore
            run_nested_tokenizer "$parsed_token"
            return $?
            ;;
        git_global_C)
            update_target "$git_target" "$parsed_token"
            git_target=$updated_target
            command_state=git_global
            ;;
        git_global_value)
            command_state=git_global
            ;;
        git_global)
            case $parsed_token in
                merge) command_state=merge_args ;;
                -C) command_state=git_global_C ;;
                -C?*)
                    update_target "$git_target" "${parsed_token#-C}"
                    git_target=$updated_target
                    ;;
                -c|--config-env|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix)
                    command_state=git_global_value
                    ;;
                -c?*|--config-env=*|--exec-path=*|--git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--|-*)
                    ;;
                *) command_state=ignore ;;
            esac
            ;;
        merge_value)
            command_state=merge_args
            ;;
        merge_args)
            case $parsed_token in
                -m|--message|-F|--file|-s|--strategy|-X|--strategy-option|--cleanup|--into-name)
                    command_state=merge_value
                    ;;
                -m?*|-F?*|-s?*|-X?*|--message=*|--file=*|--strategy=*|--strategy-option=*|--cleanup=*|--into-name=*|--|-*)
                    ;;
                refs/heads/codex/*)
                    branch=${parsed_token#refs/heads/}
                    suffix=${branch#codex/}
                    case $suffix in
                        ''|*[!A-Za-z0-9._/-]*) ;;
                        *) [ "$validate_only" = 1 ] || check_merge "$git_target" "$branch" ;;
                    esac
                    ;;
                codex/*)
                    suffix=${parsed_token#codex/}
                    case $suffix in
                        ''|*[!A-Za-z0-9._/-]*) ;;
                        *) [ "$validate_only" = 1 ] || check_merge "$git_target" "$parsed_token" ;;
                    esac
                    ;;
                *) ;;
            esac
            ;;
    esac

    return 0
}

emit_current_token() {
    [ "$token_started" = 1 ] || return 0
    process_token "$token_value"
    emit_status=$?
    token_value=
    token_started=0
    return "$emit_status"
}

tokenize() {
    scan_rest=$1
    token_value=
    token_started=0
    quote_state=none
    comment_state=0
    tab_char=$(printf '\t')
    cr_char=$(printf '\r')
    newline_char='
'

    while [ -n "$scan_rest" ]; do
        scan_char=${scan_rest%"${scan_rest#?}"}
        scan_rest=${scan_rest#?}

        if [ "$comment_state" = 1 ]; then
            if [ "$scan_char" = "$newline_char" ]; then
                comment_state=0
                reset_command_segment
            fi
            continue
        fi

        case $quote_state in
            single)
                if [ "$scan_char" = "'" ]; then
                    quote_state=none
                else
                    token_value=$token_value$scan_char
                fi
                continue
                ;;
            double)
                if [ "$scan_char" = '"' ]; then
                    quote_state=none
                    continue
                fi
                if [ "$scan_char" = "\\" ]; then
                    [ -n "$scan_rest" ] || return 1
                    next_char=${scan_rest%"${scan_rest#?}"}
                    scan_rest=${scan_rest#?}
                    if [ "$next_char" = "$newline_char" ]; then
                        continue
                    fi
                    case $next_char in
                        '"'|'$'|'`'|\\) token_value=$token_value$next_char ;;
                        *) token_value=$token_value\\$next_char ;;
                    esac
                    continue
                fi
                token_value=$token_value$scan_char
                continue
                ;;
        esac

        case $scan_char in
            "'")
                quote_state=single
                token_started=1
                ;;
            '"')
                quote_state=double
                token_started=1
                ;;
            "\\")
                [ -n "$scan_rest" ] || return 1
                next_char=${scan_rest%"${scan_rest#?}"}
                scan_rest=${scan_rest#?}
                if [ "$next_char" != "$newline_char" ]; then
                    token_value=$token_value$next_char
                    token_started=1
                fi
                ;;
            ' '|"$tab_char"|"$cr_char")
                emit_current_token
                emit_status=$?
                [ "$emit_status" -eq 0 ] || return "$emit_status"
                ;;
            "$newline_char")
                emit_current_token
                emit_status=$?
                [ "$emit_status" -eq 0 ] || return "$emit_status"
                reset_command_segment
                ;;
            ';'|'|'|'&'|'('|')')
                emit_current_token
                emit_status=$?
                [ "$emit_status" -eq 0 ] || return "$emit_status"
                reset_command_segment
                ;;
            '#')
                if [ "$token_started" = 0 ]; then
                    comment_state=1
                else
                    token_value=$token_value$scan_char
                fi
                ;;
            *)
                token_value=$token_value$scan_char
                token_started=1
                ;;
        esac
    done

    [ "$quote_state" = none ] || return 1
    emit_current_token
}

token_depth=0
validate_only=1
reset_command_parser
tokenize "$command_text" || exit 0

validate_only=0
reset_command_parser
tokenize "$command_text"
tokenize_status=$?
case $tokenize_status in
    0) exit 0 ;;
    2) exit 2 ;;
    *) exit 0 ;;
esac
