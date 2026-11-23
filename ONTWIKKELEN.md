# Verder ontwikkelen met VS Code

Deze handleiding is voor wie zelf aan Rally Printstudio wil werken: lokaal draaien, testen,
debuggen en een nieuwe ontwerptool toevoegen. Voor wat de app kan, zie de [README](README.md).

## 1. Eenmalig installeren

| Wat | Versie | Waarom |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 22 (LTS) | build, ontwikkelserver en tests (CI gebruikt ook 22, zie `.nvmrc`) |
| [Git](https://git-scm.com/) | recent | versiebeheer |
| [VS Code](https://code.visualstudio.com/) | recent | editor |

Gebruik je `nvm` of `fnm`, dan pakt `nvm use` / `fnm use` automatisch Node 22 uit `.nvmrc`.

## 2. Project openen

```bash
git clone https://github.com/grasmaaier/rally.git
cd rally
npm install
code .
```

VS Code vraagt of je de **aanbevolen extensies** wilt installeren (staan in
`.vscode/extensions.json`): Vitest (tests in de zijbalk), EditorConfig, GitHub Actions,
GitHub Pull Requests en Claude Code. Zeg ja.

De map `.vscode/` regelt verder:

- **TypeScript van het project** (`node_modules/typescript`) in plaats van de ingebouwde versie.
- **Taken** (`Terminal → Run Task…`): *Ontwikkelserver*, *Tests (alles)*, *Typecheck*, *Build*.
- **Debuggen** (`Run and Debug`, F5):
  - *App in Chrome*: start de ontwikkelserver en opent Chrome met breakpoints in je TypeScript.
  - *Huidig testbestand*: draait het open testbestand met de debugger erbij.
- `dist/` en `.claude/worktrees/` worden niet doorzocht.

Er is bewust **geen formatter-bij-opslaan** ingesteld: de code heeft geen Prettier-config en een
formatter zou hele bestanden omgooien. Volg de stijl van de code eromheen (2 spaties, enkele
quotes, puntkomma's, regels mogen lang zijn).

## 3. Dagelijks werk

```bash
npm run dev         # ontwikkelserver: http://localhost:5173 (herlaadt bij elke wijziging)
npm run typecheck   # TypeScript-controle (strict)
npm test            # alle tests (± 7–8 minuten, 1500+ tests)
npm run build       # typecheck + productie-build naar dist/
npm run preview     # de build uit dist/ bekijken
```

Tests gericht draaien (veel sneller):

```bash
npx vitest run tests/lampTube.test.ts        # één bestand
npx vitest run tests/lamp -t "Dichte bol"    # bestanden die met 'lamp' beginnen, alleen tests met die naam
npx vitest tests/thread.test.ts              # watch-modus: draait opnieuw bij elke wijziging
```

Handige omgevingsvariabelen voor de tests:

| Variabele | Effect |
| --- | --- |
| `FUZZ=200` | meer willekeurige ontwerpen per tool in `tests/fuzz.test.ts` (standaard 12) |
| `FUZZ_LOG=1` | toon trage builds en fouten van de fuzz-test |
| `SEED=7 N=200` | ander zaadje/aantal in `tests/abstract.fuzz.test.ts` |
| `REPORT=1` | maten, tijden en waarschuwingen printen in o.a. `tests/tools.test.ts` |

Voorbeeld: `FUZZ=100 FUZZ_LOG=1 npx vitest run tests/fuzz.test.ts`.

## 4. Hoe de code in elkaar zit

```
src/
  main.ts        app-schil: tabbladen, printerkeuze, panelen, koppelt alles aan elkaar
  styles.css     thema (licht/donker via CSS-variabelen)
  core/          motor: types, worker, engine, export (3MF/STL), printers, filamenten, assets
  geom/          herbruikbare geometrie: draaivormen, oppervlakken, schroefdraad, tekst, patronen …
  tools/         de ontwerptools (één ToolDef per tool) + index.ts met de lijst TOOLS
  ui/            3D-viewer (three.js), formulier, svg-iconen
  designer/      de viewport-ontwerper (nu voor Lampen): selecteren, stapel, handvatten, nodes,
                 ongedaan maken, bibliotheek, deellinks
tests/           vitest-tests (+ helpers.ts met buildTool en de overhangcontrole)
```

De weg van een schuifje naar een 3D-model:

1. `ui/form.ts` (of de designer) wijzigt de parameters (`Params`, een plat object).
2. `core/client.ts` stuurt tool-id + parameters + printer naar de **Web Worker** (`core/worker.ts`).
3. De worker laadt eventuele fonts/SVG's (`core/assets.ts`) en roept `runBuild` aan
   (`core/engine.ts`), die `tool.build(params, ctx)` uitvoert met manifold-3d (WebAssembly).
4. `runBuild` zet de onderdelen op het bed, berekent volume/oppervlak/filament, maakt meshes en
   ruimt al het WASM-geheugen op (`collect()`).
5. De viewer (`ui/viewer.ts`) toont het resultaat: *Samengesteld* (scene-items) of *Printplaat*.

## 5. Een nieuwe tool toevoegen

1. Maak `src/tools/mijntool.ts`:

```ts
import type { BuildOutput, ToolDef } from '../core/types';
import { UserError, num } from '../core/types';

export const coasterTool: ToolDef = {
  id: 'onderzetter',
  name: 'Onderzetters',
  short: 'Onderzetter',
  icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', // SVG-pad op een raster van 24×24
  description: 'Ronde onderzetter met een opstaande rand.',
  params: [
    { type: 'group', label: 'Maten' },
    { type: 'number', key: 'diameter', label: 'Diameter', min: 60, max: 150, step: 1, unit: 'mm', default: 100 },
    { type: 'number', key: 'dikte', label: 'Dikte', min: 3, max: 12, step: 0.5, unit: 'mm', default: 5 },
  ],
  presets: [{ name: 'Groot', values: { diameter: 140 } }],
  build(p, { M, printer }): BuildOutput {
    const r = num(p, 'diameter') / 2;
    const h = num(p, 'dikte');
    if (2 * r > printer.x - 10) throw new UserError('De onderzetter is te groot voor deze printer.');
    const body = M.Manifold.cylinder(h, r, r, 128);
    const recess = M.Manifold.cylinder(h, r - 3, r - 3, 128).translate([0, 0, 2]);
    return { parts: [{ name: 'Onderzetter', solid: body.subtract(recess) }] };
  },
};
```

2. Zet hem in de lijst in `src/tools/index.ts` (`TOOLS`).
3. Schrijf `tests/mijntool.test.ts`; kijk bij `tests/wallhooks.test.ts` of `tests/woodworking.test.ts`.
   De algemene tests (`tools`, `fuzz`, `memory`, `assembly`) lopen automatisch over alle tools in
   `TOOLS`, dus je tool doet daar meteen aan mee.
4. Voeg een regel toe aan de tabel in de README.

### Spelregels (hier zijn de tests streng op)

- **Gebruikersfouten** gooi je als `new UserError('Nederlandse uitleg')`. Elke andere fout geldt als
  bug: de fuzz-test probeert willekeurige parameters en accepteert alleen `UserError`.
- **WASM-geheugen**: bewerkingen van manifold (`cube`, `cylinder`, `add`, `subtract`, `translate`,
  `extrude` …) worden automatisch bijgehouden en na de build opgeruimd. Maak je iets met `new`
  (`new M.CrossSection(...)`, `new M.Manifold(mesh)`), wikkel het dan in `keep(...)` uit
  `core/registry.ts`. Gebruik `cs.toPolygons()` (die is lekvrij gemaakt). `tests/memory.test.ts`
  slaat alarm bij lekken.
- **Printbaar zonder support**: hellingen tot 45°; gebruik `overhangArea()` uit `tests/helpers.ts`
  om dat te testen. Horizontale gaten als druppel (`teardrop`), plafonds als kegel van 45°.
- **Past op de printer**: gebruik altijd `ctx.printer` (nooit een vaste maat), en geef een duidelijke
  `UserError` of deel het onderdeel op.
- **Taal**: alles wat de gebruiker ziet in het Nederlands; code en commentaar in het Engels.
- Onderdelen kunnen een `color`, `material` (filamentlijn uit `core/filaments.ts`), `purpose`
  (`'lamp'`, `'outdoor'`, `'flexible'`) en `estimate: 'vase'` meekrijgen; daar rekent de
  boodschappenlijst mee.

## 6. Git, GitHub en publiceren

- Werk op een eigen branch en open een pull request naar `main`.
- **CI** (`.github/workflows/ci.yml`) draait bij elke pull request: `npm ci`, typecheck, alle tests en
  de build. Pas mergen als die groen is.
- Elke push naar `main` publiceert de site automatisch via `.github/workflows/pages.yml` op
  <https://grasmaaier.github.io/rally/>.
- Zie je na een publicatie nog de oude versie: harde verversing (Ctrl/Cmd + Shift + R).

## 7. Problemen oplossen

| Probleem | Oplossing |
| --- | --- |
| Rode kronkels in VS Code maar `npm run typecheck` is goed | `Ctrl/Cmd+Shift+P → TypeScript: Select TypeScript Version → Use Workspace Version` |
| `Cannot find module` na een `git pull` | `npm install` (er is een dependency bijgekomen) |
| Tests lopen tegen de time-out | draai één bestand tegelijk; de standaard time-out per test is 120 s (`vite.config.ts`) |
| Vitest-extensie vindt geen tests | open de map `rally` zelf als workspace (niet een map erboven) |
| Model wordt niet bijgewerkt | kijk in de console van de browser (F12): fouten van de worker staan daar |
