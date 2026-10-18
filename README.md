# Bake Costs

A baking cost calculator for iPad. It's plain HTML, CSS and JavaScript, with no build step. See `baking-calculator-plan.md` for the spec.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Publish (GitHub Pages)

1. Create a GitHub repository and push these files to it (`index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `icons/`).
2. In the repository, go to **Settings → Pages**, choose **Deploy from a branch**, then pick `main` and `/ (root)`.
3. Open the `https://<user>.github.io/<repo>/` URL on the iPad in Safari, tap **Share → Add to Home Screen**, and launch the app from the new icon.

Data lives in the Home Screen app's own storage. It's separate from Safari's storage, so add your data after installing. Back it up with **Settings → Export data**.
