# Rally Printstudio

Een webapp met parametrische 3D-printontwerpen, afgestemd op de **Bambu Lab A2L**
(bouwvolume 330 × 320 × 325 mm). Alles draait in de browser: schuif aan de knoppen,
bekijk het model live in 3D en download een **3MF** die je direct in Bambu Studio opent.

## Wat zit erin

| Tool | Wat je ermee maakt |
| --- | --- |
| **Vazen & lampenkappen** | Profiel met 4 diameters, doorsnede (rond, veelhoek, bloem, ster, schelp, kantelen), draaiing (gelijkmatig, zacht, heen-en-weer), horizontale golven, low-poly facetten. Drie soorten: spiraalvaas (vase mode), vaas/bak met echte wand, of lampenkap met E27/E14-spin. "Verras me" geeft een willekeurig ontwerp. |
| **Gridfinity** | Bakken volgens de Gridfinity-standaard (42 mm raster, 7 mm hoogte-eenheid) met vakken, schep, labelrand, stapelrand en magneet-/schroefgaten. Basisplaten (licht, dicht of met magneten) en een **ladeplanner**: geef de binnenmaat van je lade op en je krijgt een passend raster met opvulrand, opgedeeld in stukken die op je printbed passen. |
| **Knoppen & grepen** | Knoppen (paddenstoel, cilinder, trechter, bol) met grip (ribbels, facetten, kartel), staafgrepen, beugelgrepen (D-greep) en schelpgrepen. Standaard gatafstanden 64–320 mm, bevestiging met M3/M4/M5: zelftappend gat, ingeklemde moer of inzetmoer. |
| **Verbindingen** | Plankverbinders (I, L, T, X en eigen hoek), 3D-kasthoeken voor kastjes van panelen, en verbinders voor ronde stokken of vierkante latten in elke richting (ook driepoten). Liggende gaten zijn druppelvormig en staande hubs krijgen 45°-steunen, zodat alles zonder support print. |
| **Meubels met hout** | Open kast/boekenkast, kastje van panelen en tafel/bank/kruk van latten. Je krijgt een 3D-weergave van het hele meubel, een **zaaglijst** (ook als CSV voor de bouwmarkt) en alle printbare verbinders in de juiste aantallen, verdeeld over printplaten. |
| **Plantenpotten** | Zelfwaterende potten (reservoir + binnenpot met 45°-trechter, wiekkolom en vulbuisje). Kies **staand**, **hangend** of **aan de muur** en het ontwerp past zich aan: schotel met ribbels, ophanglipjes plus ophangring, of een vlakke achterkant met sleutelgaten. Toont ook hoeveel water en potgrond erin past. |

Verder:

- **Doorsnede**-weergave om het binnenwerk te bekijken (handig bij de plantenpotten).
- **Samengesteld / Printplaat**: bekijk het geheel of hoe de onderdelen op het bed liggen.
- Controle of alles op de printer past, met een schatting van het filamentgebruik.
- Export als **3MF** (alles of per printplaat) en **STL** (per onderdeel of alles).
- Elke instelling staat in de link: met **Deel ontwerp** kopieer je een link naar precies dit ontwerp.
- Andere Bambu-printers (H2D, A1, P1S/X1C/P2S, A1 mini) zijn ook te kiezen.
- Licht en donker thema, werkt ook op telefoon en tablet.

## Starten

```bash
npm install
npm run dev        # ontwikkelserver op http://localhost:5173
npm test           # tests: geldige modellen, geen botsingen in meubels/potten, export, geheugen, fuzz
npm run build      # productie-build in dist/
```

De build in `dist/` is een statische site: zet hem op elke webserver of op GitHub Pages.

### GitHub Pages

De workflow `.github/workflows/pages.yml` publiceert elke push naar `main` automatisch.
Zet daarvoor één keer in de repository-instellingen **Settings → Pages → Source** op
**GitHub Actions**.

## Hoe het werkt

- **Geometrie**: [manifold-3d](https://github.com/elalish/manifold) (WebAssembly) voor
  booleaanse bewerkingen. Elk model is gegarandeerd *manifold* (waterdicht), dus de slicer
  krijgt nooit kapotte meshes.
- **Rekenen in een Web Worker**: de interface blijft vloeiend terwijl je schuift.
- **3D-weergave**: three.js met het printbed en bouwvolume van de gekozen printer.
- **Export**: eigen 3MF-schrijver (core-spec, millimeters, objecten centraal op het bed)
  en binaire STL.

```
src/
  core/      engine, worker, 3MF/STL-export, printerprofielen, plaatindeling
  geom/      vormhulpmiddelen: omwentelingsoppervlakken, afrondingen, schroefgaten
  tools/     de zes ontwerptools (elk: parameters + bouwfunctie)
  ui/        3D-viewer en formulier
tests/       geometrie-, samenstellings- en exporttests
```

Een nieuwe tool toevoegen: maak een bestand in `src/tools/` dat een `ToolDef` exporteert
(parameters, voorbeelden en een `build`-functie die manifolds teruggeeft) en registreer
het in `src/tools/index.ts`. Het formulier, de 3D-weergave en de export werken dan vanzelf.

## Printtips voor de A2L

- Het bed van de A2L wordt maximaal 80 °C: ideaal voor PLA, PETG en TPU.
- **Lampenkappen**: gebruik alleen LED-lampen. PLA wordt zacht rond 55 °C.
- **Plantenpotten voor buiten**: PETG is UV- en waterbestendiger dan PLA.
- **Dragende verbinders** (meubels, tafelhoeken): 4 wanden en 30–40% infill.
- **Speling**: meet je hout na. "18 mm" plaatmateriaal is in de praktijk vaak 17,6–18,4 mm.
