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
  micrometres, coloured by epoch, and can be downloaded as CSV.
- Keeps the position, field of view, band and mode in the page address, so a view can be
  shared as a link. `&embed=1` hides the side panels.

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

The first request for a new position is slow: the IRSA query takes 20 to 30 seconds and
each exposure costs about 0.5 MB of download. Answers are cached on disk. Results for the
five test targets at the default field of view are shipped in `data/seed/`, so they open
at once. After a new SPHEREx data release, refresh them with:

```
python backend/make_seed.py --refresh
```

## API

- `GET /api/epochs?ra=&dec=` lists the epochs at a position and the number of exposures per band.
- `GET /api/stack?ra=&dec=&fov=&det=` returns one stacked image per epoch for one band
  (`fov` in arcseconds, 30 to 600; `det` 1 to 6). Images are base64 little-endian float32
  in MJy/sr on a 3.075 arcsecond grid, row 0 at the south edge.
- `GET /api/spectrum?ra=&dec=&fov=&pra=&pdec=` returns one point per exposure at the spot
  (`pra`, `pdec`) inside that view: wavelength and bandwidth in micrometres, flux and noise
  in mJy, date, detector and epoch. The flux is an aperture sum (radius 12.3 arcseconds)
  minus the median of a surrounding ring; no aperture correction is applied.
- `GET /api/health`

## Known limits

- The pixel-quality flags and the zodiacal-light model in the SPHEREx files are not used
  yet. The background is removed with a clipped median of each cutout.
- Very bright stars have empty (saturated) cores in some bands.
- The field of view is at most 10 arcminutes, which is too small to search for a distant
  planet that would move by many arcminutes between visits.
- The spectrum aperture is wider than the image resolution, so a neighbour within about
  12 arcseconds is included in the measurement. Exposures with saturated pixels in the
  aperture are skipped, which leaves very bright stars with few or no points.

## Code layout

- `backend/spx/index.py` asks IRSA which exposures cover a position.
- `backend/spx/s3fits.py` reads a cutout from a FITS file on S3 with byte-range requests.
- `backend/spx/tanwcs.py` is a small TAN-SIP world coordinate implementation in NumPy.
- `backend/spx/stack.py` groups exposures into epochs and stacks them.
- `backend/spx/wave.py` gives the wavelength of each detector pixel (from the WCS-WAVE
  extension of the SPHEREx files); `backend/spx/spectrum.py` does the photometry.
- `backend/app.py` is the HTTP API; `frontend/` is the viewer (plain HTML, CSS and JavaScript).

## Data and software credits

- SPHEREx data: NASA/JPL-Caltech, served by the NASA/IPAC Infrared Science Archive (IRSA).
- NumPy, SciPy, Astropy, Requests, FastAPI, Uvicorn.
- The idea of blinking epochs of an infrared survey follows WiseView.

## Use of AI

The code in this repository was written with the help of an AI coding assistant
(Claude Code, Anthropic), working under the direction of the team. Files written this way
carry the note "AI-assisted code (Claude Code)".

## License

MIT. See [LICENSE](LICENSE).
