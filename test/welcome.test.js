// Tests du lanceur d'accueil src/terminal/welcome.zsh (node:test) : rendu Ghostty (kitty), Terminal.app (texte),
// rendu natif sans fastfetch, gardes (shell interactif, DOJO_WELCOME=off, FASTFETCH_SHOWN, autre terminal).
// Chaque test travaille dans un HOME temporaire installé comme ~/.config/claude-dojo/terminal/ ; fastfetch est
// remplacé par un faux binaire qui enregistre ses arguments et la config reçue (sortie déterministe).
// L'environnement des processus zsh est reconstruit de zéro : TERM_PROGRAM et DOJO_* du poste ne fuient pas.
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src', 'terminal', 'welcome.zsh');
const ZSH = ['/bin/zsh', '/usr/bin/zsh', '/opt/homebrew/bin/zsh'].find((p) => fs.existsSync(p));
const SYS_PATH = '/usr/bin:/bin';
const ESC = '\x1b';

// ── Helpers ──────────────────────────────────────────────────────────────
const CREATED = [];
function tmpDir(prefix = 'dojo-welcome-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  CREATED.push(d);
  return d;
}
after(() => { for (const d of CREATED) fs.rmSync(d, { recursive: true, force: true }); });

// fastfetch présent sur le PATH système ? Si oui, les cas « sans fastfetch » ne sont pas reproductibles ici.
const systemHasFastfetch = spawnSync('/bin/sh', ['-c', 'command -v fastfetch'], { env: { PATH: SYS_PATH }, encoding: 'utf8' }).status === 0;
const skipReason = ZSH ? false : 'zsh absent';
const noSystemFastfetch = systemHasFastfetch ? 'fastfetch présent sur le PATH système' : false;

const write = (file, data, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  if (mode) fs.chmodSync(file, mode);
  return file;
};

// Faux fastfetch : écrit ses arguments, copie la config (-c) dans $DOJO_TEST_OUT, affiche une marque.
// Comme le vrai fastfetch, refuse une config sans suffixe .jsonc (il la prendrait pour un preset).
const STUB = `#!/bin/sh
cfg=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-c" ]; then cfg="$a"; fi
  prev="$a"
done
case "$cfg" in
  *.jsonc) ;;
  "") ;;
  *) echo "Error: couldn't find config: $cfg" >&2; exit 1 ;;
esac
printf '%s\\n' "$@" > "$DOJO_TEST_OUT/args.txt"
[ -n "$cfg" ] && cp "$cfg" "$DOJO_TEST_OUT/cfg.jsonc"
echo "FF-STUB"
`;

const LISTS = [
  'key1|mission',
  'key2|jutsu',
  'accent|242;140;40',
  'value|243;233;210',
  'cols|30',
  'rows|12',
  'l1|Escorter le pont de Tazuna',
  'l1|Retrouver le chat "Tora"',
  'l2|Kage Bunshin · clones d\'ombre',
  'l2|Chemin \\ avec antislash',
].join('\n') + '\n';
const L1 = ['Escorter le pont de Tazuna', 'Retrouver le chat "Tora"'];
const L2 = ['Kage Bunshin · clones d\'ombre', 'Chemin \\ avec antislash'];
const JSONC = '{\n  "logo": { "type": "data" },\n  "modules": [\n    "title",\n    // @DYNAMIC@\n    "break",\n    "os"\n  ]\n}\n';

// Installe welcome.zsh et un thème de fixtures comme le ferait l'installeur : HOME/.config/claude-dojo/terminal/.
function installHome({ withTheme = true, lists = LISTS } = {}) {
  const home = tmpDir();
  const term = path.join(home, '.config', 'claude-dojo', 'terminal');
  write(path.join(term, 'welcome.zsh'), fs.readFileSync(SRC));
  write(path.join(home, '.config', 'claude-dojo', 'config.json'), JSON.stringify({ theme: 'naruto', background: null }, null, 2));
  if (withTheme) {
    const theme = path.join(term, 'theme');
    write(path.join(theme, 'fastfetch.jsonc'), JSONC);
    write(path.join(theme, 'fastfetch-text.jsonc'), JSONC);
    write(path.join(theme, 'logo.txt'), 'ASCII\n LOGO\n');
    write(path.join(theme, 'logo.png'), 'png-fixe');
    write(path.join(theme, 'frames', 'frame_01.png'), 'png-1');
    write(path.join(theme, 'frames', 'frame_02.png'), 'png-2');
    if (lists !== null) write(path.join(theme, 'lists.txt'), lists);
  }
  return { home, term, welcome: path.join(term, 'welcome.zsh') };
}

function stubBin(home) {
  return path.join(write(path.join(home, 'stub-bin', 'fastfetch'), STUB, 0o755), '..');
}

// Lance zsh (-i par défaut) avec un environnement reconstruit de zéro.
function zsh(home, script, { term = 'Apple_Terminal', pathDirs = [SYS_PATH], extra = {}, interactive = true } = {}) {
  const outDir = path.join(home, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const env = {
    HOME: home,
    ZDOTDIR: home,
    TMPDIR: home,
    LANG: 'en_US.UTF-8',
    PATH: pathDirs.join(':'),
    DOJO_TEST_OUT: outDir,
    ...extra,
  };
  if (term !== null) env.TERM_PROGRAM = term;
  const args = interactive ? ['-ic', script] : ['-c', script];
  const r = spawnSync(ZSH, args, { env, input: '', encoding: 'utf8', timeout: 60000 });
  const leftovers = fs.readdirSync(home).filter((n) => n.startsWith('dojo-welcome.'));
  return { code: r.status, out: r.stdout, err: r.stderr, outDir, leftovers };
}

const readOut = (r, name) => fs.readFileSync(path.join(r.outDir, name), 'utf8');
const readCfg = (r) => JSON.parse(readOut(r, 'cfg.jsonc'));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
// « ✦ libellé   valeur » -> [libellé, valeur]
const splitLine = (s) => { const m = s.match(/^✦ (\S+)\s+(.+)$/); return m ? [m[1], m[2]] : [null, null]; };
const src = (welcome) => `source '${welcome}'`;
const kittyPayloads = (out) => {
  const re = new RegExp(`${ESC}_G([^;${ESC}]*);([A-Za-z0-9+/=]*)${ESC}\\\\`, 'g');
  return [...out.matchAll(re)].map((m) => ({ params: m[1], file: Buffer.from(m[2], 'base64').toString('utf8') }));
};

// ── Syntaxe ──────────────────────────────────────────────────────────────
test('welcome.zsh : syntaxe zsh valide (zsh -n)', { skip: skipReason }, () => {
  const r = spawnSync(ZSH, ['-n', SRC], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ── Terminal.app : logo texte + lignes dynamiques injectées ──────────────
test('Terminal.app avec fastfetch : config texte reçue avec deux modules dynamiques valides', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '', 'aucune sortie d\'erreur');
  assert.match(r.out, /FF-STUB/);
  assert.equal(r.leftovers.length, 0, 'fichier temporaire supprimé');

  const args = readOut(r, 'args.txt').split('\n');
  assert.ok(args.includes('--logo-type') && args.includes('file'), 'logo texte passé en fichier');
  assert.ok(args.some((a) => a.endsWith(path.join('theme', 'logo.txt'))));

  // La config reçue doit être du JSON valide une fois la ligne @DYNAMIC@ remplacée
  const cfg = readCfg(r);
  const customs = cfg.modules.filter((m) => typeof m === 'object' && m.type === 'custom');
  assert.equal(customs.length, 2, 'un item l1 et un item l2');
  // libellé dans key (accent), valeur dans format
  const lab1 = stripAnsi(customs[0].key).replace(/^✦ /, '');
  const lab2 = stripAnsi(customs[1].key).replace(/^✦ /, '');
  const val1 = stripAnsi(customs[0].format);
  const val2 = stripAnsi(customs[1].format);
  assert.equal(lab1, 'mission');
  assert.equal(lab2, 'jutsu');
  assert.ok(L1.includes(val1), `item l1 attendu, reçu ${JSON.stringify(val1)}`);
  assert.ok(L2.includes(val2), `item l2 attendu, reçu ${JSON.stringify(val2)}`);
  // couleurs : accent sur la clé, couleur de valeur sur format, décodées par JSON.parse en vrais ESC
  assert.ok(customs[0].key.startsWith(`${ESC}[38;2;242;140;40m✦ mission`));
  assert.ok(customs[0].format.startsWith(`${ESC}[38;2;243;233;210m`));
  // colonne commune : --key-width = plus longue clé (« ✦ mission ») + séparateur (2) + 1
  assert.equal(args[args.indexOf('--key-width') + 1], String('✦ mission'.length + 2 + 1));
  // les modules existants restent à leur place
  assert.equal(cfg.modules[0], 'title');
  assert.equal(cfg.modules[cfg.modules.length - 1], 'os');
});

test('Terminal.app : guillemets et antislash des items restent intacts après échappement JSON', { skip: skipReason }, () => {
  // Accolades : fastfetch les lit comme placeholders, elles sortent donc en parenthèses
  const special = 'key1|mission\nkey2|jutsu\nl1|Retrouver le chat "Tora" {#}\nl2|Chemin \\ avec antislash\n';
  const { home, welcome } = installHome({ lists: special });
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  const values = readCfg(r).modules.filter((m) => typeof m === 'object').map((m) => stripAnsi(m.format));
  assert.deepEqual(values, ['Retrouver le chat "Tora" (#)', 'Chemin \\ avec antislash']);
});

test('Terminal.app : colonne des valeurs alignée sur la plus longue clé (thème et libellés)', { skip: skipReason }, () => {
  // clés du thème à 14 colonnes (comme stargate-sg1) ; libellé dynamique plus long que la colonne (« ✦ mission de héros »)
  const themed = '{\n  "modules": [\n    { "type": "title", "key": "✦ opérateur   ", "format": "{user-name}" },\n    // @DYNAMIC@\n    "os"\n  ]\n}\n';
  const lists = 'key1|mission de héros\nkey2|jutsu\nl1|Escorter le pont de Tazuna\nl2|Kage Bunshin\n';
  const { home, welcome, term } = installHome({ lists });
  write(path.join(term, 'theme', 'fastfetch-text.jsonc'), themed);
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  const args = readOut(r, 'args.txt').split('\n');
  // plus longue clé : « ✦ mission de héros » (18) + 2 + 1
  assert.equal(args[args.indexOf('--key-width') + 1], '21');
  assert.equal(readCfg(r).modules[0].key, '✦ opérateur   ', 'clés du thème inchangées');
});

test('Terminal.app : clés du thème plus larges que les libellés, --key-width suit le thème', { skip: skipReason }, () => {
  const themed = '{\n  "modules": [\n    { "type": "title", "key": "✦ opérateur   ", "format": "{user-name}" },\n    // @DYNAMIC@\n    "os"\n  ]\n}\n';
  const lists = 'key1|mission\nkey2|jutsu\nl1|Escorter le pont de Tazuna\nl2|Kage Bunshin\n';
  const { home, welcome, term } = installHome({ lists });
  write(path.join(term, 'theme', 'fastfetch-text.jsonc'), themed);
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  const args = readOut(r, 'args.txt').split('\n');
  // plus longue clé : « ✦ opérateur   » (14) ; libellés « ✦ mission » (9) : 14 + 2 + 1
  assert.equal(args[args.indexOf('--key-width') + 1], '17');
});

// ── Rendu natif : fastfetch absent ───────────────────────────────────────
test('Terminal.app sans fastfetch : rendu natif (titre + 2 lignes), code 0, stderr vide', { skip: skipReason || noSystemFastfetch }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const lines = r.out.split('\n').filter((l) => l.trim() !== '').map(stripAnsi);
  assert.equal(lines[0], '✦ claude-dojo · naruto', 'titre avec le thème de config.json');
  assert.equal(lines.length, 3, `titre + 2 lignes dynamiques, reçu : ${JSON.stringify(lines)}`);
  const [lab1, val1] = splitLine(lines[1]);
  const [lab2, val2] = splitLine(lines[2]);
  assert.equal(lab1, 'mission');
  assert.equal(lab2, 'jutsu');
  assert.ok(L1.includes(val1));
  assert.ok(L2.includes(val2));
  assert.ok(r.out.includes(`${ESC}[38;2;242;140;40m`), 'titre et libellés en couleur accent');
});

test('theme/ absent : rendu natif avec le seul titre, sans erreur', { skip: skipReason }, () => {
  const { home, welcome } = installHome({ withTheme: false });
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const lines = r.out.split('\n').filter((l) => l.trim() !== '').map(stripAnsi);
  assert.deepEqual(lines, ['✦ claude-dojo · naruto']);
  assert.ok(!fs.existsSync(path.join(r.outDir, 'args.txt')), 'fastfetch non appelé');
});

test('lists.txt absent : fastfetch lancé sans modules dynamiques', { skip: skipReason }, () => {
  const { home, welcome } = installHome({ lists: null });
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.match(r.out, /FF-STUB/);
  assert.deepEqual(readCfg(r).modules, ['title', 'break', 'os']);
});

// ── Ghostty : animation kitty ────────────────────────────────────────────
test('Ghostty : deux frames kitty (chemins décodés), frame précédente supprimée, config Ghostty utilisée', { skip: skipReason }, () => {
  const { home, welcome, term } = installHome();
  const r = zsh(home, src(welcome), { term: 'ghostty', pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  const frames = kittyPayloads(r.out);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].file, path.join(term, 'theme', 'frames', 'frame_01.png'));
  assert.equal(frames[1].file, path.join(term, 'theme', 'frames', 'frame_02.png'));
  assert.match(frames[0].params, /^a=T,f=100,t=f,i=8001,/);
  assert.match(r.out, new RegExp(`${ESC}_Ga=d,d=I,i=8001`), 'frame précédente supprimée');
  assert.match(r.out, /FF-STUB/);
  const args = readOut(r, 'args.txt').split('\n');
  assert.ok(args.includes('--logo-type') && args.includes('data'));
  assert.equal(readCfg(r).modules.filter((m) => typeof m === 'object').length, 2);
  assert.equal(r.leftovers.length, 0);
});

test('Ghostty avec DOJO_ANIM=0 : une seule image fixe logo.png', { skip: skipReason }, () => {
  const { home, welcome, term } = installHome();
  const r = zsh(home, src(welcome), { term: 'ghostty', pathDirs: [stubBin(home), SYS_PATH], extra: { DOJO_ANIM: '0' } });
  assert.equal(r.code, 0, r.err);
  const payloads = kittyPayloads(r.out);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].file, path.join(term, 'theme', 'logo.png'));
});

test('Ghostty sans fastfetch : rendu natif, aucune commande graphique', { skip: skipReason || noSystemFastfetch }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome), { term: 'ghostty', pathDirs: [SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  assert.equal(kittyPayloads(r.out).length, 0);
  assert.match(stripAnsi(r.out), /✦ claude-dojo/);
});

// ── Gardes ───────────────────────────────────────────────────────────────
test('DOJO_WELCOME=off : sortie vide, code 0', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH], extra: { DOJO_WELCOME: 'off' } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  assert.ok(!fs.existsSync(path.join(r.outDir, 'args.txt')));
});

test('deuxième sourçage dans le même shell (FASTFETCH_SHOWN) : rien de plus', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, `${src(welcome)}; echo ---; ${src(welcome)}; echo FFS=$FASTFETCH_SHOWN`, { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  const [before, after] = r.out.split('---\n');
  assert.match(before, /FF-STUB/);
  assert.equal(after, 'FFS=1\n');
});

test('autre terminal (iTerm) : rien, FASTFETCH_SHOWN non exporté', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, `${src(welcome)}; echo FFS=\${FASTFETCH_SHOWN:-unset}`, { term: 'iTerm.app', pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'FFS=unset\n');
});

test('TERM_PROGRAM absent : rien', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome), { term: null, pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

test('shell non interactif (zsh -c) : rien', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const r = zsh(home, src(welcome), { pathDirs: [stubBin(home), SYS_PATH], interactive: false });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '');
});

// ── Pas d'effet de bord hors de dojo_welcome ─────────────────────────────
test('sourçage : options du shell inchangées, seule FASTFETCH_SHOWN apparaît comme nouveau paramètre', { skip: skipReason }, () => {
  const { home, welcome } = installHome();
  const script = [
    'setopt > "$DOJO_TEST_OUT/opt.before"',
    'print -rl ${(k)parameters} | sort > "$DOJO_TEST_OUT/par.before"',
    src(welcome),
    'setopt > "$DOJO_TEST_OUT/opt.after"',
    'print -rl ${(k)parameters} | sort > "$DOJO_TEST_OUT/par.after"',
  ].join('; ');
  const r = zsh(home, script, { pathDirs: [stubBin(home), SYS_PATH] });
  assert.equal(r.code, 0, r.err);
  assert.equal(readOut(r, 'opt.before'), readOut(r, 'opt.after'), 'options identiques');
  const before = new Set(readOut(r, 'par.before').split('\n'));
  const added = readOut(r, 'par.after').split('\n').filter((n) => n && !before.has(n));
  assert.deepEqual(added, ['FASTFETCH_SHOWN']);
});
