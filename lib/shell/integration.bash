# dsh-web-terminal shell integration for bash (Linux and Git Bash), used as `bash --rcfile <this> -i`.
#
# Emits invisible OSC sequences so the web UI can split the session into command blocks:
#   133;A prompt start, 133;B prompt end, 133;C output start, 133;D;<exit> command finished,
#   633;E;<command line> the command, 633;P;Cwd=<folder> the real current folder.
# --rcfile replaces ~/.bashrc, so the normal startup is reproduced first; the user's PROMPT_COMMAND and PS1 are kept.

# Normal startup. With --rcfile bash still sources /etc/bash.bashrc itself where the distro builds it in, so only the
# personal files are read here. A login shell (Git Bash: DSH_WT_BASH_LOGIN=1) ignores --rcfile altogether, hence the
# host starts it as a plain interactive shell and this reproduces what `-l` would have read.
if [ -n "${DSH_WT_BASH_LOGIN-}" ]; then
  unset DSH_WT_BASH_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
  fi
else
  [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi

# Only once, only interactive.
[ -n "${__dsh_wt_loaded-}" ] && return 0
case $- in *i*) ;; *) return 0 ;; esac
__dsh_wt_loaded=1

# VS Code's escaping: backslash, ';' and control characters become \\ and \xNN so a value never ends the OSC early.
__dsh_esc() {
  local s=$1 c i out
  # Replacements are quoted variables: bash 5.2 would otherwise treat a backslash (and &) in the replacement specially.
  local bs='\' semi='\x3b' nl='\x0a' cr='\x0d' tab='\x09' esc='\x1b' bel='\x07'
  s=${s//\\/"$bs$bs"}
  s=${s//;/"$semi"}
  s=${s//$'\n'/"$nl"}
  s=${s//$'\r'/"$cr"}
  s=${s//$'\t'/"$tab"}
  s=${s//$'\e'/"$esc"}
  s=${s//$'\a'/"$bel"}
  if [[ $s == *[[:cntrl:]]* ]]; then
    out=
    for ((i = 0; i < ${#s}; i++)); do
      c=${s:i:1}
      if [[ $c == [[:cntrl:]] ]]; then printf -v c '%02x' "'$c"; c=$bs'x'$c; fi
      out+=$c
    done
    s=$out
  fi
  __dsh_escaped=$s
}

# Git Bash reports /c/Users/x; the UI wants C:/Users/x. Drive mounts convert in pure bash, anything else asks cygpath once per folder.
__dsh_cwd=
__dsh_cwd_for=
__dsh_native_cwd() {
  [ "$PWD" = "$__dsh_cwd_for" ] && return
  __dsh_cwd_for=$PWD
  __dsh_cwd=$PWD
  case $OSTYPE in
    msys* | cygwin*)
      if [[ $PWD =~ ^/([a-zA-Z])(/.*)?$ ]]; then
        __dsh_cwd="${BASH_REMATCH[1]^^}:${BASH_REMATCH[2]:-/}"
      elif command -v cygpath >/dev/null 2>&1; then
        __dsh_cwd=$(cygpath -m "$PWD" 2>/dev/null) || __dsh_cwd=$PWD
      fi
      ;;
  esac
}

__dsh_ran=
__dsh_last_histcmd=$HISTCMD
__dsh_nil=()

# Runs first in PROMPT_COMMAND: report the finished command, the folder, and the new prompt. Returns the old $? so the user's own PROMPT_COMMAND sees it.
__dsh_precmd() {
  local status=$? h
  if [ -n "$__dsh_ran" ]; then
    __dsh_ran=
    # E needs the command line, which only history has. Skip it when history did not record this command (HISTCONTROL=ignorespace).
    if [ "${HISTCMD-0}" != "$__dsh_last_histcmd" ]; then
      local HISTTIMEFORMAT=
      h=$(builtin history 1)
      if [[ $h =~ ^[[:space:]]*[0-9]+[[:space:]]+(.*)$ ]]; then
        __dsh_esc "${BASH_REMATCH[1]}"
        printf '\e]633;E;%s\a' "$__dsh_escaped"
      fi
    fi
    printf '\e]133;D;%s\a' "$status"
  fi
  __dsh_last_histcmd=${HISTCMD-0}
  __dsh_native_cwd
  __dsh_esc "$__dsh_cwd"
  printf '\e]633;P;Cwd=%s\a\e]133;A\a' "$__dsh_escaped"
  __dsh_armed=
  return $status
}

# Runs last in PROMPT_COMMAND: PROMPT_COMMAND (starship, direnv...) may have rewritten PS1 since startup, so B is appended here.
__dsh_B=$'\[\e]133;B\a\]'
__dsh_postcmd() {
  local status=$?
  [[ $PS1 == *"$__dsh_B" ]] || PS1+=$__dsh_B
  __dsh_armed=1
  return $status
}

# C: PS0 (bash 4.4+) is printed after the line is read and before it runs. The subscript is evaluated by the parent shell
# and expands to nothing, which is how "a command ran" reaches __dsh_precmd without a fork.
if [ "${BASH_VERSINFO[0]}" -gt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -ge 4 ]; }; then
  [ -z "${DSH_WT_FORCE_DEBUG_TRAP-}" ] && __dsh_ps0=1
fi
if [ -n "${__dsh_ps0-}" ]; then
  PS0='${__dsh_nil[__dsh_ran=1]-}\e]133;C\a'"${PS0-}"
else
  # Older bash: the DEBUG trap fires before every simple command; the first one after the prompt is the user's command.
  # Skipped when something else already owns the trap.
  __dsh_armed=
  __dsh_debug() {
    [ -n "$__dsh_armed" ] || return 0
    [ -n "${COMP_LINE-}" ] && return 0
    __dsh_armed=
    __dsh_ran=1
    printf '\e]133;C\a'
  }
  [ -z "$(trap -p DEBUG)" ] && trap '__dsh_debug' DEBUG
fi

if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == "declare -a"* ]]; then
  PROMPT_COMMAND=(__dsh_precmd "${PROMPT_COMMAND[@]}" __dsh_postcmd)
else
  PROMPT_COMMAND="__dsh_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND};__dsh_postcmd"
fi
