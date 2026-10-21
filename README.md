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
| **Lampen** | Stapelbare hang- en tafellampen uit tot acht segmenten die over een standaard holle draadbuis M10x1 schuiven: bol, kussen/donut, cilinder, tol/zigzag, diabolo, kegel, koepel, boog, ziggurat, bloem- en tandwielschijf, platte schijf, afstandshouders (hals of losse stijlen zodat schijven lijken te zweven), open kappen (cilinder, kegel, klok, koepel, getrapt) en lamellen voor een lagenkoepel. Elk segment glad, met fijne plissé, ribbels of ringen en in een eigen kleur; centreerkegels houden de stapel recht. E27/E14/G9-fitting met echte lampmaten (A60, G95, G125, kogel, kaars…) en controle van de afstand tot het glas. Tafellamp met verzwaarde voet, bodemplaat en kabelsleuf (plus kantelcontrole); hanglamp met kapje over de trekontlasting en plafondkap. Alles print zonder support; voorbeelden: totem plissé, Memphis, lagenkoepel, bloemetjeslamp, ziggurat. |
| **Generatief** | Organische, generatieve prints van een 3D-model: upload een **STL** (binair of tekst), **OBJ** of **3MF** of kies een ingebouwd voorwerp (telefoon, oordopjes-case, ei, bol). Maak er een nauwsluitende **hoes/kooi** van (instelbare speling en wand, open aan boven- of onderkant of in twee helften), een **standaard** met vertakte, botachtige stutten die het voorwerp schuin achterover houdt (rand, rugsteun, kabelsleuf, stabiliteitscontrole van het zwaartepunt) of een **lattice-versie** van het model zelf (geperforeerde huid of 3D-vakwerk). Patronen: Voronoi, organische blobs en gyroid, glad afgerond met signed distance fields. Grote modellen worden vereenvoudigd; modellen met gaten werken ook. |
| **Houtbewerking** | Hulpmiddelen voor de werkplaats: **hoekmal** om zaagblad of verstekgeleider in te stellen (eigen hoeken, als zaagbladstand of hoek tussen de randen), **zwaluwstaartmal** 1:5–1:10 (zacht/hard hout), **afschuinmal** voor vellingkanten, **middelpuntzoeker** voor rond hout (90°-V met liniaal op de bissectrice) en **middenlijnmal** voor plankkanten (twee pennen, potlood in het midden), **duwstok**, duwschoen en **duwblok** met plat geprinte greep, vervangbare hak en TPU-zool, **kantlijnmal** met gaatjes per mm, **instelblokjes** 0,5–100 mm voor zaagblad- en freeshoogte, **lijmhoeken** in elke hoek, **boorgeleider** (haaks of schuin tot 45°, V-groef voor rond hout), **deuvelmal** die zichzelf centreert, **gaatjesmal** voor het 32 mm-systeem, **scharniermal** voor potscharnieren, **veerbord** en **beitelhoekmeter**. Hoeken en gaten liggen in het nauwkeurige XY-vlak; alles print zonder support, met tips over sterkte en kalibratie. |

Verder:

- **Doorsnede**-weergave om het binnenwerk te bekijken (handig bij de plantenpotten).
- **Samengesteld / Printplaat**: bekijk het geheel of hoe de onderdelen op het bed liggen.
- Controle of alles op de printer past, met een schatting van het filamentgebruik.
- Export als **3MF** (alles of per printplaat, met de filamentkleur per object) en **STL** (per onderdeel of alles).
- Elke instelling staat in de link: met **Deel ontwerp** kopieer je een link naar precies dit ontwerp.
- **Printerkeuze** rechtsboven: de hele Bambu Lab-reeks (A1 mini, A1, A2L, P1P, P1S, P2S, X1 Carbon, X1E, X2D, H2S, H2D en H2C; dual-nozzle printers ook met het kleinere bereik van beide nozzles samen). Pascontrole, plaatindeling, foutmeldingen en de printplaat in de viewer volgen de gekozen printer; de keuze wordt onthouden.
- **Filamentkeuze** per onderdeel (of voor alles tegelijk) uit de Bambu Lab-filamenten: PLA Basic/Matte/Silk+/Translucent/Galaxy/Sparkle/Marble/Wood, PETG HF/Translucent/CF, ABS, ASA, TPU 95A HF, TPU for AMS, PC, PAHT-CF en Support for PLA/PETG, met de echte kleurnamen en -codes. De viewer toont de kleur, doorschijnend filament ook doorschijnend; lampenkappen stellen zelf PETG Translucent voor.
- **Boodschappenlijst**: gewicht en meters per onderdeel met de dichtheid van het gekozen filament, hoeveel rollen per kleur je moet kopen (met % gebruikt en indicatieve prijs), tips voor transparant filament, waarschuwingen (PLA bij een lamp, ABS op een open printer, TPU of CF in de AMS lite) en of het aantal kleuren in de AMS van je printer past. Te kopiëren of te printen.
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
  geom/      vormhulpmiddelen: omwentelingsoppervlakken, 2D-vormen, tekst, poten, afrondingen, schroefgaten,
             afstandsvelden en patronen voor generatieve vormen, STL/OBJ/3MF inlezen
  tools/     de elf ontwerptools (elk: parameters + bouwfunctie)
  ui/        3D-viewer en formulier
tests/       geometrie-, samenstellings- en exporttests
```

Een nieuwe tool toevoegen: maak een bestand in `src/tools/` dat een `ToolDef` exporteert
(parameters, voorbeelden en een `build`-functie die manifolds teruggeeft) en registreer
het in `src/tools/index.ts`. Het formulier, de 3D-weergave en de export werken dan vanzelf.

## Printtips voor de A2L

- Het bed van de A2L wordt maximaal 80 °C: ideaal voor PLA, PETG en TPU.
- **Lampenkappen en lampen**: gebruik alleen LED-lampen. PLA wordt zacht rond 55 °C; print delen dicht bij de lamp in PETG.
- **Plantenpotten voor buiten**: PETG is UV- en waterbestendiger dan PLA.
- **Dragende verbinders** (meubels, tafelhoeken): 4 wanden en 30–40% infill.
- **Speling**: meet je hout na. "18 mm" plaatmateriaal is in de praktijk vaak 17,6–18,4 mm.
