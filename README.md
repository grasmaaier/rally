# Rally Printstudio

Een webapp met parametrische 3D-printontwerpen, afgestemd op de **Bambu Lab A2L**
(bouwvolume 330 × 320 × 325 mm). Alles draait in de browser: schuif aan de knoppen,
bekijk het model live in 3D en download een **3MF** die je direct in Bambu Studio opent.

## Wat zit erin

| Tool | Wat je ermee maakt |
| --- | --- |
| **Vazen & lampenkappen** | Profiel met 4 diameters of een profielstijl (getrapt, bollen, golvend, facet/kristal), doorsnede uit de vormenbibliotheek (rond, veelhoek, bloem, blaadjes, ster, kruis, klaver, wolk, blob, hart, druppel, blad, superformule… of je eigen SVG), organische vervorming, draaiing (gelijkmatig, zacht, heen-en-weer), horizontale golven, low-poly facetten. Drie soorten: spiraalvaas (vase mode), vaas/bak met echte wand, of lampenkap met E27/E14-spin. "Verras me" geeft een willekeurig ontwerp. |
| **Gridfinity** | Bakken volgens de Gridfinity-standaard (42 mm raster, 7 mm hoogte-eenheid) met vakken, schep, labelrand, stapelrand en magneet-/schroefgaten. Basisplaten (licht, dicht of met magneten) en een **ladeplanner**: geef de binnenmaat van je lade op en je krijgt een passend raster met opvulrand, opgedeeld in stukken die op je printbed passen. |
| **Knoppen & grepen** | Klassieke knoppen (paddenstoel, cilinder, trechter, bol) met grip, en designknoppen met een zachte kussenvorm: kruis, blob, echte bloem, ster, hart, wolk, klaver, druppel, kiezel, donut, tandwiel, superformule of eigen SVG. Staafgrepen (ook gedraaid, golvend, bot en tak), beugelgrepen (D-greep, golf, lus) en schelpgrepen. Standaard gatafstanden 64–320 mm, bevestiging met M3/M4/M5: zelftappend gat, ingeklemde moer of inzetmoer. |
| **Verbindingen** | Plankverbinders (I, L, T, X en eigen hoek), 3D-kasthoeken voor kastjes van panelen, en verbinders voor ronde stokken of vierkante latten in elke richting (ook driepoten). Liggende gaten zijn druppelvormig en staande hubs krijgen 45°-steunen, zodat alles zonder support print. |
| **Meubels met hout** | Open kast/boekenkast, kastje van panelen (beide ook op pootjes), tafel/bank/kruk van latten, **verhogingen/plankstandaards** voor bureau of keukentafel (rechthoekig, rond, ovaal of designvorm; op poten of een geprinte ring; tot 3 etages) en losse meubelpoten (6 profielen, 13 doorsneden, schuin, gedraaid, viltje of M8-stelvoet). Je krijgt een 3D-weergave van het hele meubel, een **zaaglijst** (ook als CSV voor de bouwmarkt) en alle printbare verbinders in de juiste aantallen, verdeeld over printplaten. |
| **Plantenpotten** | Zelfwaterende potten (reservoir + binnenpot met 45°-trechter, wiekkolom en vulbuisje). Kies **staand**, **hangend** of **aan de muur** en het ontwerp past zich aan: schotel met ribbels, ophanglipjes plus ophangring, of een vlakke achterkant met sleutelgaten. Toont ook hoeveel water en potgrond erin past. Alle vaasvormen en profielstijlen werken ook hier. |
| **Klokken** | Nieuwe wijzerplaat, cijfers en wijzers voor een standaard quartz-uurwerk uit een oude klok. Wijzerplaat in elke vorm (ook eigen SVG) met rand en uitsparing achter; cijfers 1–12, Romeins, kwartieren of eigen tekst in 14 meegeleverde Google Fonts, elk Google Font op naam of een eigen fontbestand; acht wijzerstijlen of eigen SVG met gatmaten voor Europese en Amerikaanse uurwerken. Ook losse wandcijfers en een pasproef voor de wijzergaten. |
| **Tandenborstelhouders** | Wandhouders voor elektrische tandenborstels (Philips Sonicare, Oral-B, Oral-B iO of eigen maat) die met losse zuignappen (bijv. Bambu HA011 40 mm) aan tegels of spiegel hangen: beker, ophangvork of opladerplank, opzetborstels en tandpasta. Merkmaten zijn richtwaarden; de pasproef controleert ze. |

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
  geom/      vormhulpmiddelen: omwentelingsoppervlakken, 2D-vormen, tekst, poten, afrondingen, schroefgaten
  tools/     de acht ontwerptools (elk: parameters + bouwfunctie)
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
