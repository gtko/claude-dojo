# claude-dojo : accueil des nouvelles fenêtres de terminal (lanceur générique).
# Sourcé depuis ~/.zshrc, installé dans ~/.config/claude-dojo/terminal/welcome.zsh.
#
# Le thème actif est le dossier theme/ à côté de ce fichier :
#   fastfetch.jsonc        config Ghostty (protocole graphique kitty)
#   fastfetch-text.jsonc   config Terminal.app (logo texte)
#   logo.png               image fixe (animation désactivée, ou pas de frames/)
#   frames/frame_NN.png    frames de l'animation kitty (facultatives, 8 images au plus)
#   logo.txt               logo texte pour Terminal.app
#   lists.txt              lignes « clé|valeur » (voir plus bas)
# Dans les .jsonc, la ligne « // @DYNAMIC@ » reçoit deux modules custom tirés au hasard
# (un item de l1 et un de l2) : libellé dans key, valeur dans format. La colonne des valeurs
# est commune à tous les modules (--key-width, calculé depuis les clés du thème et les libellés).
#
# lists.txt : une ligne par réglage ; l1 et l2 se répètent, un item par ligne.
#   key1|libellé de la 1re ligne        key2|libellé de la 2e ligne
#   accent|242;140;40                   value|243;233;210     (R;G;B)
#   cols|30                             rows|12               (taille du logo, Ghostty)
#   l1|premier item                     l2|autre item
#
# Terminal.app : logo texte. Ghostty : animation kitty. Autre terminal : rien.
# fastfetch absent, en échec ou sans sortie : rendu natif (titre et 2 lignes), sans rien d'autre.
# Variables : DOJO_WELCOME=off désactive, DOJO_ANIM=0 garde l'image fixe.
# Seule dojo_welcome agit (export de FASTFETCH_SHOWN, sortie) : le sourçage ne crée aucune variable.

dojo_welcome() {
  emulate -L zsh
  setopt null_glob

  [[ -o interactive ]] || return 0
  [[ ${DOJO_WELCOME:-on} == off ]] && return 0
  [[ -n ${FASTFETCH_SHOWN:-} ]] && return 0

  local mode
  case ${TERM_PROGRAM:-} in
    ghostty) mode=kitty ;;
    Apple_Terminal) mode=text ;;
    *) return 0 ;;
  esac
  export FASTFETCH_SHOWN=1

  # Dossier du thème : à côté du fichier sourcé ($1), chemin absolu
  local D=""
  [[ -n ${1:-} ]] && D=${1:h:a}/theme

  # lists.txt : réglages (kv) et items l1 / l2
  local -A kv=()
  local -a l1=() l2=()
  local line key val
  if [[ -n $D && -r $D/lists.txt ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      line=${line//[[:cntrl:]]/}
      [[ $line == *'|'* ]] || continue
      key=${line%%'|'*}
      val=${line#*'|'}
      case $key in
        l1) l1+=("$val") ;;
        l2) l2+=("$val") ;;
        *) kv[$key]=$val ;;
      esac
    done 2>/dev/null < $D/lists.txt
  fi

  local acc=${kv[accent]:-242;140;40} txt=${kv[value]:-243;233;210}
  [[ $acc == <0-255>\;<0-255>\;<0-255> ]] || acc=242\;140\;40
  [[ $txt == <0-255>\;<0-255>\;<0-255> ]] || txt=243\;233\;210
  local cols=30 rows=12 pad=2
  [[ ${kv[cols]:-} == <1-200> ]] && cols=${kv[cols]}
  [[ ${kv[rows]:-} == <1-200> ]] && rows=${kv[rows]}

  # Couleurs : séquences réelles pour le rendu natif, séquences JSON (\u001b) pour fastfetch
  local esc=$'\e'
  local nacc="${esc}[38;2;${acc}m" ntxt="${esc}[38;2;${txt}m" nz="${esc}[0m"
  local jacc="\\u001b[38;2;${acc}m" jtxt="\\u001b[38;2;${txt}m" jz='\u001b[0m'

  # Un item de l1 et un de l2 au hasard, avec leur libellé
  local -a dlabel=() dvalue=()
  (( ${#l1} )) && { dlabel+=("${kv[key1]:-}"); dvalue+=("${l1[RANDOM % ${#l1} + 1]}"); }
  (( ${#l2} )) && { dlabel+=("${kv[key2]:-}"); dvalue+=("${l2[RANDOM % ${#l2} + 1]}"); }
  local lw=${#kv[key1]}
  (( ${#kv[key2]} > lw )) && lw=${#kv[key2]}

  local ins="" i lab jl jv
  local -a nlines=()
  for (( i = 1; i <= ${#dvalue}; i++ )); do
    lab=${(r:lw:)dlabel[i]}
    val=${dvalue[i]}
    nlines+=("${nacc}✦ ${lab}${nz} ${ntxt}${val}${nz}")
    # Échappement JSON : \ puis " ; fastfetch lit { } comme placeholders, remplacés par ( )
    jl=${dlabel[i]//\\/\\\\}; jl=${jl//\"/\\\"}; jl=${jl//\{/'('}; jl=${jl//\}/')'}
    jv=${val//\\/\\\\}; jv=${jv//\"/\\\"}; jv=${jv//\{/'('}; jv=${jv//\}/')'}
    # module custom : libellé dans key (accent), valeur dans format ; la colonne est fixée par --key-width
    ins+="{ \"type\": \"custom\", \"key\": \"${jacc}✦ ${jl}${jz}\", \"format\": \"${jtxt}${jv}${jz}\" }, "
  done

  # Titre : nom du thème lu dans config.json (affichage seulement, valeur validée)
  local theme="" cfgj=$HOME/.config/claude-dojo/config.json
  if [[ -r $cfgj ]]; then
    theme=$(sed -n 's/.*"theme"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfgj" 2>/dev/null | head -n 1)
    [[ -n $theme && ${#theme} -le 64 && ${theme//[^a-z0-9-]/} == $theme ]] || theme=""
  fi

  # fastfetch seulement si installé et si le thème est là ; sinon rendu natif
  local ff=0
  command -v fastfetch >/dev/null 2>&1 && [[ -d $D ]] && ff=1

  # Animation kitty : frames/ puis logo.png. 8 images au plus, prises uniformément (la dernière incluse)
  local -a all=() frames=()
  local n k
  if (( ff )) && [[ $mode == kitty ]]; then
    [[ ${DOJO_ANIM:-1} == 0 ]] || all=("$D"/frames/frame_*.png)
    (( ${#all} )) || { [[ -r $D/logo.png ]] && all=("$D"/logo.png); }
    (( ${#all} )) || ff=0
  fi
  n=${#all}
  if (( n > 8 )); then
    for (( k = 0; k < 8; k++ )); do frames+=("${all[1 + k * (n - 1) / 7]}"); done
  else
    frames=("${all[@]}")
  fi
  if (( ff )); then
    if [[ $mode == text ]]; then
      [[ -r $D/fastfetch-text.jsonc ]] || ff=0
    else
      [[ -r $D/fastfetch.jsonc ]] || ff=0
    fi
  fi

  # fastfetch : sortie capturée, affichée seulement si rc 0 et non vide ; sinon rendu natif.
  # La config vit dans un dossier mktemp (nom imprévisible), supprimé par always dans tous les cas.
  local ok=0 rc=1 cfgdir="" ffout="" txt_cfg="" pat='// @DYNAMIC@'
  local cfg=$D/fastfetch.jsonc
  local -a kwarg=() jkeys=() b64s=()
  local kmax=0 id prev=0 b64 f ln cur="" enc="" blank="" logo=""
  [[ $mode == text ]] && cfg=$D/fastfetch-text.jsonc
  {
    if (( ff )); then
      # colonne des valeurs : fastfetch place chaque valeur à --key-width (colonne absolue) ; elle doit
      # dépasser la plus longue clé suivie du séparateur (2) : clés du thème et libellés dynamiques (« ✦ » + libellé)
      jkeys=("${(@f)$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" 2>/dev/null)}")
      for k in $jkeys; do (( ${#k} > kmax )) && kmax=${#k}; done
      for k in $dlabel; do (( ${#k} + 2 > kmax )) && kmax=$(( ${#k} + 2 )); done
      (( kmax )) && kwarg=(--key-width $(( kmax + 3 )))
      # la ligne @DYNAMIC@ devient les modules ; le suffixe .jsonc est obligatoire (fastfetch -c sans
      # extension cherche un preset)
      txt_cfg=$(<"$cfg")
      txt_cfg=${txt_cfg//${pat}/$ins}
      cfgdir=$(mktemp -d "${TMPDIR:-/tmp}/dojo-welcome.XXXXXX" 2>/dev/null) || cfgdir=""
      if [[ -n $cfgdir ]] && print -r -- "$txt_cfg" >| "$cfgdir/fastfetch.jsonc" 2>/dev/null; then
        cfg=$cfgdir/fastfetch.jsonc
      else
        ff=0
      fi
    fi
    if (( ff )); then
      if [[ $mode == text ]]; then
        local -a logo_args=(--logo none)
        [[ -r $D/logo.txt ]] && logo_args=(--logo "$D/logo.txt" --logo-type file)
        ffout=$(fastfetch -c "$cfg" "${kwarg[@]}" "${logo_args[@]}" 2>/dev/null); rc=$?
      else
        # Ghostty : zone du logo réservée (lignes vides) que fastfetch remplit
        blank=${(l:cols:: :)}
        logo=$(for _ in {1..$rows}; do print -r -- "$blank"; done)
        ffout=$(fastfetch -c "$cfg" "${kwarg[@]}" --logo-type data --logo "$logo" \
          --logo-padding-left $pad --logo-padding-right 4 --logo-padding-top 0 2>/dev/null); rc=$?
      fi
      (( rc == 0 && ${#ffout} )) && ok=1
    fi
  } always {
    if [[ -n $cfgdir ]]; then rm -rf -- "$cfgdir" 2>/dev/null; fi
  }

  if (( ok )); then
    if [[ $mode == text ]]; then
      print
      print -r -- "$ffout"
    else
      # Ghostty : seulement une fois fastfetch réussi. Chemins encodés en base64 par une seule
      # substitution ; une ligne « # » ferme chaque chemin (« # » n'appartient pas à l'alphabet base64).
      zmodload zsh/zselect 2>/dev/null
      enc=$(for f in $frames; do print -rn -- "$f" | base64; print -r -- '#'; done)
      for ln in "${(@f)enc}"; do
        if [[ $ln == '#' ]]; then b64s+=("$cur"); cur=""; else cur+=$ln; fi
      done
      # zone du logo réservée (lignes vides), frames kitty dessinées par-dessus, puis le texte fastfetch
      printf '\n%.0s' {1..$rows}
      printf '\e[%dA\e[%dG\e7' $rows $((pad + 1))
      i=0
      for b64 in $b64s; do
        (( i++ ))
        id=$((8000 + i))
        printf '\e8\e_Ga=T,f=100,t=f,i=%d,p=1,c=%d,r=%d,C=1,q=2;%s\e\\' $id $cols $rows "$b64"
        (( prev )) && printf '\e_Ga=d,d=I,i=%d,q=2\e\\' $prev
        prev=$id
        (( ${#b64s} > 1 )) && zselect -t 4 2>/dev/null
      done
      printf '\e8\e[1G'
      print -r -- "$ffout"
    fi
  else
    # rendu natif : titre accent puis les 2 lignes dynamiques
    print
    print -r -- "${nacc}${esc}[1m✦ claude-dojo${theme:+ · $theme}${nz}"
    for line in $nlines; do print -r -- "$line"; done
  fi
  return 0
}

# Sourçage : ${(%):-%x} est le chemin de ce fichier. Hors shell interactif, rien ne s'affiche.
dojo_welcome "${(%):-%x}"
