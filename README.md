# SPHEREx Blink

A web tool for looking for things that move or change in the SPHEREx all-sky survey.
Enter a sky position, and the tool shows the SPHEREx images of that patch of sky from each
visit of the telescope, one after another, like a short film. A star that moved between
visits jumps; a star that changed brightness flickers.

Built for the NASA Space Apps Challenge 2026, challenge "Planet X and SPHEREx".

## What it does

- Takes a position as decimal degrees (`133.7598 -7.2422`) or as hours and degrees
  (`08h55m10.831s -07d14m42.53s`, `17:57:48.5 +04:41:36`).
- Finds every SPHEREx exposure that covers that position and groups them into epochs
  (visits separated by more than 30 days, or 60-day blocks where coverage is continuous).
- For each of the six detector bands and each epoch, averages all exposures onto one
  north-up grid, so that epochs can be compared. Single SPHEREx exposures cannot be compared
  directly, because consecutive exposures of one spot are taken at different wavelengths.
- Shows the result in three modes: **Blink** (epochs in turn), **Difference** (one epoch
  minus another; a moving source shows as a blue and red pair), and **Stack** (all epochs).
- Measures a **spectrum** of any spot you click. Each exposure sees the spot through a
  different part of SPHEREx's linear variable filter, so each exposure gives one point
  (wavelength, brightness). The points of all six detectors together cover 0.75 to 5
  micrometres, coloured by epoch, and can be downloaded as CSV. The chart can also show the
  median in each of SPHEREx's **102 spectral channels** (17 per band).
- Overlays **Gaia DR3** and **CatWISE2020** sources. Each mark is drawn where the
  catalogue's proper motion puts the source on the date of the epoch shown, so a mark that
  follows a star from epoch to epoch confirms the motion independently. Sources with a
  well-measured motion above 0.15 arcseconds per year get a trail and a label.
- Shows every band and visit in one table (**bands × visits**), with the number of exposures
  behind each image, and steps through visits or through bands.
- Measures the **marked source**: click a source and the tool follows it from visit to
  visit, gives its shift in arcseconds and arcseconds per year, and checks whether Gaia DR3
  or CatWISE2020 lists an object there. A source no catalogue knows can be saved as a
  **candidate** (kept in the browser, exportable as CSV).
- Lists **changes in the field** between the first and the last visit: sources that moved,
  brightened or faded.
- Offers fields of view from 2 arcminutes to **1 degree**. Fields up to 10 arcminutes are
  drawn on a grid twice as fine as the detector pixels; 30 arcminutes and 1 degree use the
  detector pixels themselves (6.15 arcseconds).
- Shows the **quality flags** that the SPHEREx pipeline stores with every exposure: pixels
  flagged in a fifth or more of the exposures of a visit are painted over the image, and the
  panel names the flags that occur (transient, halo, persistence and so on).
- Shows the image with only the **zodiacal-light model** removed, instead of the whole
  background, and gives the model's level and what is left of the sky after it.
- Keeps the position, field of view, band, mode, overlays and marked source in the page
  address, so a view can be shared as a link. `&embed=1` shows the image and timeline only.
  The Share menu also opens the same field in Aladin Lite.
- Works on a phone, in a light and a dark theme, and uses the room on wide and ultrawide
  screens (the image and the table grow, the findings panel splits into columns).

The site has six pages: Home (`/`), the tool (`/explore`), Targets, Method, API (`/api-docs`)
and About. `/explore?pick=1` opens a random field away from the Milky Way and the ecliptic poles.

The five test targets named in the challenge are one click away: Barnard's Star,
Epsilon Indi B, WISE 0855-0714, RW Aurigae and R Draconis.

## Run it

Python 3.12:

```
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Linux/macOS: .venv/bin/pip
.venv/Scripts/python -m uvicorn app:app --app-dir backend --port 8000
```

Then open http://localhost:8000.

With Docker:

```
docker build -t spherex-blink .
docker run -p 7860:7860 spherex-blink
```

The container listens on `$PORT` if the host sets it, otherwise on 7860.

## How it gets the data

| Step | Source |
| --- | --- |
| Which exposures cover a position | IRSA TAP service, tables `spherex.plane` and `spherex.artifact` |
| Pixels | Level 2 spectral images in the public `nasa-irsa-spherex` bucket on Amazon S3, read as byte ranges so that only the rows around the target are downloaded |
| Object names (optional) | CDS Sesame name resolver |
| Catalogue overlays (optional) | Gaia DR3 from the ESA Gaia archive TAP service; CatWISE2020 from IRSA TAP |

The first request for a new position is slow: the IRSA query takes 20 to 30 seconds and
each exposure costs about 0.5 MB of download (3.5 MB for a 30-arcminute field, 7 MB for
1 degree: about 10 and 40 seconds for 84 exposures on our connection). Answers are cached
on disk. Results for the five test targets at the default field of view are shipped in
`data/seed/`, so they open at once.

### Staying current

SPHEREx data reach the archive every week. The server keeps the list of exposures of each
position it has been asked for; when that list is more than seven days old, the next visit
shows the stored result at once and asks IRSA again in the background. If there are new
exposures the page reloads them, and the stacks, spectra and quality data of that position
are rebuilt, because each stored result records how many exposures it was made from.
The shipped results for the test targets are refreshed with one command, which a weekly
cron job can run:

```
python backend/make_seed.py --refresh
```

There is no separate copy of the whole SPHEREx exposure table: the lists are fetched per
position, on demand.

## API

- `GET /api/epochs?ra=&dec=` lists the epochs at a position and the number of exposures per band,
  with the age of that list in days (`index_age_days`).
- `GET /api/stack?ra=&dec=&fov=&det=` returns one stacked image per epoch for one band
  (`fov` in arcseconds, 30 to 3600; `det` 1 to 6). Images are base64 little-endian float32
  in MJy/sr, row 0 at the south edge, on a 3.075 arcsecond grid up to `fov=600` and on
  6.15 arcseconds above; the answer gives `pixscale`.
- `GET /api/quality?ra=&dec=&fov=&det=` returns, per epoch and on the same grid: `flag`, a
  base64 uint8 map with the share (0 to 255) of the exposures in which each pixel carries a
  quality flag; `names`, the share of the field each flag touches; `zodi`, the modelled
  zodiacal light in MJy/sr; and `corr`, a 3 by 3 grid to add to the stack so that only the
  zodiacal model is removed.
- `GET /api/spectrum?ra=&dec=&fov=&pra=&pdec=` returns one point per exposure at the spot
  (`pra`, `pdec`) inside that view: wavelength and bandwidth in micrometres, flux and noise
  in mJy, date, detector and epoch. The flux is an aperture sum (radius 12.3 arcseconds)
  minus the median of a surrounding ring; no aperture correction is applied. `aper` sets the
  aperture radius in native pixels (1 to 3, default 2): a smaller aperture keeps neighbours
  out but loses more of the target's own light.
- `GET /api/catalog?name=gaia|catwise&ra=&dec=&fov=` returns the catalogue sources in the
  view: position at the catalogue's reference epoch, proper motion in mas/yr and its
  significance, and a magnitude (G for Gaia, W2 for CatWISE).
- `GET /api/health`

## Known limits

- The quality flags are shown, not applied: flagged pixels still enter the stacks. The
  stack is a clipped mean, which already drops a pixel that is off in a single exposure.
  The flags FULLSAMPLE and SOURCE describe a pixel without calling it bad and are left out.
- The stacks themselves have the clipped median of each cutout removed. The "Zodi removed"
  layer adds back the difference between that median and the zodiacal model, with the model
  taken as a plane across the cutout (within 0.2 % of the model in the file we compared).
- Very bright stars have empty (saturated) cores in some bands.
- In the wide fields (30 arcminutes, 1 degree) the other five bands load only when chosen,
  the catalogue marks are the 400 brightest sources, and the exposures used are those that
  cover the centre of the field, so the corners can have fewer.
- The 102 channels are nominal: each band is divided into 17 parts of equal width in log
  wavelength, which is close to, but not exactly, the instrument's channel boundaries.
- The spectrum aperture is wider than the image resolution, so a neighbour within about
  12 arcseconds is included in the measurement. Exposures with saturated pixels in the
  aperture are skipped, which leaves very bright stars with few or no points.
- The shift of the marked source and the list of changes are measured in the browser from
  the stacked images (brightness-weighted centre in each visit). They are a guide for the
  eye, not calibrated astrometry: faint or blended sources can give a false shift, and a
  saturated star is located from its wings with an error of a few arcseconds. On the five
  test targets the measured motions are 9.3 (Barnard's Star, catalogue 10.4), 4.5
  (Epsilon Indi B, catalogue 4.7) and 7.7 (WISE 0855-0714) arcseconds per year.
- GIF export of the blink is shown in the Share menu but switched off.

## Code layout

- `backend/spx/index.py` asks IRSA which exposures cover a position.
- `backend/spx/s3fits.py` reads a cutout from a FITS file on S3 with byte-range requests.
- `backend/spx/tanwcs.py` is a small TAN-SIP world coordinate implementation in NumPy.
- `backend/spx/stack.py` groups exposures into epochs and stacks them.
- `backend/spx/quality.py` reads the FLAGS extension (Rice-compressed, one image row per
  table row, so a block of rows is still one byte range) and the ZODI extension.
- `backend/spx/wave.py` gives the wavelength of each detector pixel (from the WCS-WAVE
  extension of the SPHEREx files); `backend/spx/spectrum.py` does the photometry.
- `backend/app.py` is the HTTP API and serves the pages.
- `frontend/` is plain HTML, CSS and JavaScript, with no build step. `site.css` and `site.js`
  hold the shared look, theme and top bar; `sky.js` the image helpers; `explore.html`,
  `explore.css`, `app.js` (data, image, table, timeline, spectrum) and `discover.js`
  (motion, catalogue check, candidates, change list, menus, phone sheet) are the tool.

## Data and software credits

- SPHEREx data: NASA/JPL-Caltech, served by the NASA/IPAC Infrared Science Archive (IRSA).
- Gaia DR3: European Space Agency (ESA) mission Gaia, processed by the Gaia Data Processing
  and Analysis Consortium (DPAC).
- CatWISE2020: based on data from NASA's WISE and NEOWISE missions, served by IRSA.
- NumPy, SciPy, Astropy, Requests, FastAPI, Uvicorn.
- The idea of blinking epochs of an infrared survey follows WiseView.

## Use of AI

The code in this repository was written with the help of an AI coding assistant
(Claude Code, Anthropic), working under the direction of the team. Files written this way
carry the note "AI-assisted code (Claude Code)".

## License

MIT. See [LICENSE](LICENSE).
