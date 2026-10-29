# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-10-29

### Added
- **Sample groups.** A group is a named set of samples that share one gating tree. Gates belong to a group, so one session can hold files that need different gating — two panels, two experiments, two acquisition days. A sample may belong to several groups, and the active group decides what the Gate tab shows.
- **Copy gating between groups**, reissuing gate ids so the two trees stay independent.
- **Per-sample gate adjustment.** A switch on the selected gate chooses whether a drag edits the whole group or only the active sample. Sample-scoped edits are stored as overrides, leave the group's shape untouched, and are marked with a dot in the plot, the population tree and the sample list. Overrides reset one at a time or for a whole group.
- **Group statistics.** The Statistics tab blocks rows by group and offers an optional `mean ± SD (n=…)` summary row per population. The CSV gained group, summary-flag, n, adjusted-flag and per-value SD columns.
- Figure export and the gating scheme follow the active group.
- **A grouped demo dataset.** The demo is now two donors of three samples each plus the compensation controls, arriving pre-grouped. Donor B was "run on a different day": its scatter sits ~20,000 FSC and ~16,000 SSC higher, so donor A's gate catches only 14% of it against 50% for donor B's own gate — one tree cannot serve both.
- **Open worked example**, a second start option loading that data with a finished analysis: a gating tree per donor and one gate nudged on a file that drifted past its group's gate.

### Changed
- Project files store groups, membership and overrides. A 1.0 project opens unchanged: its single tree becomes one group holding every sample.

## [1.0.0] — 2026-10-26

First public release.

### Analysis
- FCS 2.0 / 3.0 / 3.1 reader (integer, float and double; both byte orders; `$PnE` log amplification converted to linear on read), validated against the `flowio` Python library on nine files from different instruments.
- Spillover compensation from the file's own matrix, edited by hand with a live before/after preview, or computed from single-stain controls against an unstained control.
- Per-channel transforms: linear, log, arcsinh and logicle with automatic width estimation.
- Interactive hierarchical gating: rectangle, polygon, ellipse, interval and quadrant gates, all editable after drawing; downstream populations recompute immediately.
- Population statistics (count, % of parent, % of all) with median, mean, geometric mean or robust CV per marker; CSV export.
- Export any gated population as a new FCS file.

### Output
- Gating scheme view showing every step on one page.
- Six figure layouts: current plot, gating strategy, samples in columns, samples in rows, histogram overlay and stacked histograms.
- Free-form layout: place plot panels anywhere, resize them, and annotate with text and arrows.
- Panels can overlay several samples, several populations, or both, with a legend carrying gate frequencies or event counts.
- PNG (1×/2×/4×), vector SVG with editable text, and PDF via the print dialog.

### Data management
- Project files (`.fwproj`) bundling the original FCS bytes with the complete analysis.
- Gating templates (`.json`) carrying gates, transforms and compensation to a new batch of files.
