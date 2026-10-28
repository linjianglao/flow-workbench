# Contributing

Thanks for taking a look. This is a small project; issues and pull requests are both welcome.

## Reporting a bug

The most valuable report is **an FCS file this tool misreads**. The parser was written from the FCS 2.0/3.0/3.1 specifications and checked against nine real files, but instrument vendors interpret the standard liberally and there are certainly files out there it gets wrong.

When filing, please include:

- what you expected and what happened
- your browser and operating system
- the instrument and acquisition software, if the problem involves a file
- a small FCS file that reproduces it, if you are able to share one

If the file is unpublished or otherwise sensitive, say so in the issue rather than attaching it — the FCS header and keyword segment alone (the first few kilobytes) are often enough to diagnose a parsing problem, and the app's own *FCS Strip* equivalent is not implemented yet.

## Working on the code

```bash
git clone https://github.com/linjianglao/flow-workbench.git
cd flow-workbench
python3 build.py        # rebuild after any change in src/
node tests/core.test.js # fast unit tests, no browser needed
python3 tests/e2e.py    # Playwright walkthrough of the real UI
```

Edit files in `src/` and rebuild — never edit `dist/flow_workbench.html` or `docs/index.html` directly, since both are generated and your changes will be overwritten.

### How the code is organised

`src/core.js` is deliberately free of any DOM reference so it can be unit-tested under Node. Anything that touches a canvas, an element or an event belongs in `src/ui.js` or one of the feature files. Plot drawing goes through a single `paintPlot` routine so that the screen, PNG and SVG outputs can never drift apart.

### Conventions

- No build tooling and no runtime dependencies. If a change needs a library, open an issue first so we can discuss whether the single-file property is worth keeping.
- Gates are stored in **raw data units**, never in screen or transformed coordinates, so that changing a transform moves gates with the data.
- New analysis code that produces a number should come with a test in `tests/core.test.js` that checks it against a value derived independently.

## Scope

Things that fit: FCS compatibility, gate types, transforms, statistics, figure output, accessibility, performance.

Things that probably do not: a server component, user accounts, or anything that would send data off the user's machine. The privacy guarantee is a core feature, not an implementation detail.
