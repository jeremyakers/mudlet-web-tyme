# Tyme client image provenance

`tyme-banner.png` is the canonical 800×100 banner also used by the public
homepage as `images/tymebanner4-dark.png` (the files are byte-identical).

The favicon/PWA mark is the existing right-hand square emblem from that banner,
not a new logo. `tyme-mark.png` preserves the preferred 80×80 crop. The other
checked-in rasters avoid a build-time image dependency. They were derived with
ImageMagick using:

```sh
convert tyme-banner.png -crop 80x80+652+10 +repage tyme-mark.png
convert tyme-mark.png -resize 64x64 icon-tyme-64.png
convert tyme-mark.png -resize 192x192 icon-tyme-192.png
convert tyme-mark.png -resize 512x512 icon-tyme-512.png
convert tyme-mark.png -resize 288x288 \
  -background 'srgb(19,21,25)' -gravity center -extent 512x512 \
  icon-tyme-maskable-512.png
```

The maskable background is the crop's actual top-left pixel. The
[manifest safe-zone guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons)
requires important artwork to fit a central circle whose radius is 40% of the
icon width (also illustrated by [web.dev](https://web.dev/articles/maskable-icon)).
A centered square's corner distance is `side / sqrt(2)`, so 512×0.4×sqrt(2)
allows 289.63 px; the 288 px square therefore keeps all existing artwork inside
the 204.8 px radius, with 112 px margins. These conversion commands document
the preferred-source derivation; the normal client build only copies the
checked-in PNGs and does not require ImageMagick.

Artwork provenance is separate from the software license: the artwork keeps its
own history and copyright, and publishing this source grants no trademark
rights.
