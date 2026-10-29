#!/usr/bin/env python3
"""End-to-end walkthrough of the built app in a real browser.

    pip install playwright && playwright install chromium
    python3 tests/e2e.py [--headed]

Exercises: loading demo data, drawing every gate type by simulated mouse input,
compensation from controls, CSV/FCS/PNG/SVG export, and a project save/reopen
cycle verifying that population counts survive unchanged.
"""
import asyncio, json, os, pathlib, sys, tempfile

from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = (ROOT / "dist" / "flow_workbench.html").as_uri()
HEADED = "--headed" in sys.argv

failures, checks = [], 0


def check(name, cond, detail=""):
    global checks
    checks += 1
    if cond:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}{'  -> ' + str(detail) if detail else ''}")


async def main():
    tmp = pathlib.Path(tempfile.mkdtemp())
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not HEADED)
        ctx = await browser.new_context(viewport={"width": 1500, "height": 950}, accept_downloads=True)
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)

        await page.goto(APP)
        await page.click("#btnDemo")
        await page.wait_for_timeout(600)
        n = await page.evaluate("FW.S.samples.length")
        check("demo data loads 8 samples", n == 8, n)

        px = lambda x, y: page.evaluate(f"FW.toPx({x},{y})")

        async def name_gate(label):
            await page.wait_for_selector(".pop input")
            await page.fill(".pop input", label)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(200)

        # polygon
        await page.keyboard.press("p")
        for x, y in [(42000, 6000), (85000, 6000), (88000, 32000), (60000, 36000), (40000, 28000)]:
            X, Y = await px(x, y)
            await page.mouse.click(X, Y)
            await page.wait_for_timeout(40)
        await page.keyboard.press("Enter")
        await name_gate("Lymphocytes")
        check("polygon gate created", await page.evaluate("FW.S.gates.length") == 1)

        # rectangle inside it
        await page.click("#popTree li:nth-child(2)")
        await page.select_option("#selX", "FSC-A")
        await page.select_option("#selY", "FSC-H")
        await page.keyboard.press("r")
        (X0, Y0), (X1, Y1) = await px(40000, 30000), await px(95000, 80000)
        await page.mouse.move(X0, Y0); await page.mouse.down()
        await page.mouse.move(X1, Y1, steps=5); await page.mouse.up()
        await name_gate("Single cells")

        # interval on a histogram
        await page.click("#popTree li:nth-child(3)")
        await page.select_option("#selX", "FITC-A")
        await page.select_option("#selY", "")
        await page.keyboard.press("i")
        (X0, Y0), (X1, Y1) = await px(1500, 0), await px(250000, 0)
        await page.mouse.move(X0, Y0); await page.mouse.down()
        await page.mouse.move(X1, Y1, steps=5); await page.mouse.up()
        await name_gate("T cells")

        # quadrant
        await page.click("#popTree li:nth-child(4)")
        await page.select_option("#selX", "PE-A")
        await page.select_option("#selY", "APC-A")
        await page.keyboard.press("q")
        X, Y = await px(1500, 2500)
        await page.mouse.click(X, Y)
        await page.wait_for_timeout(300)
        types = await page.evaluate("JSON.stringify(FW.S.gates.map(g=>g.type))")
        check("all gate types drawn", json.loads(types) == ["poly", "rect", "interval"] + ["quad"] * 4, types)

        counts = json.loads(await page.evaluate(
            "JSON.stringify(FW.S.gates.map(g=>FW.getPop(FW.S.samples[0],g.id).length))"))
        check("every gate contains events", all(c > 0 for c in counts[:3]), counts)

        # compensation from single-stain controls
        await page.click(".tab[data-tab=comp]")
        await page.wait_for_timeout(400)
        await page.click("#btnCompute")
        await page.wait_for_timeout(600)
        msg = await page.inner_text("#computeMsg")
        check("spillover computed from controls", "Computed from" in msg, msg[:80])

        # statistics CSV
        await page.click(".tab[data-tab=stats]")
        await page.wait_for_timeout(400)
        async with page.expect_download() as dl:
            await page.click("#btnCsv")
        csv = pathlib.Path(await (await dl.value).path()).read_text()
        check("statistics CSV has a row per population per sample",
              len(csv.strip().splitlines()) == 1 + 8 * 8, len(csv.strip().splitlines()))

        # population export as FCS
        async with page.expect_download() as dl:
            await page.evaluate("FW.S.view.pop=FW.S.gates[2].id")
            await page.click("#btnFcsExport")
        fcs = pathlib.Path(await (await dl.value).path()).read_bytes()
        check("exported FCS has a valid header", fcs[:3] == b"FCS", fcs[:6])

        # figure export, PNG and SVG
        await page.click(".tab[data-tab=export]")
        await page.wait_for_timeout(500)
        svg = await page.evaluate("()=>FW.figureSvg(FW.buildFigure())")
        check("SVG export keeps text as text", svg.count("<text") > 10, svg.count("<text"))
        async with page.expect_download() as dl:
            await page.click("#btnExportFig")
        png = pathlib.Path(await (await dl.value).path()).read_bytes()
        check("PNG export is a real PNG", png[:8] == b"\x89PNG\r\n\x1a\n")

        # project round trip
        async with page.expect_download() as dl:
            await page.click("#btnSaveProj")
        proj = tmp / "test.fwproj"
        proj.write_bytes(pathlib.Path(await (await dl.value).path()).read_bytes())
        check("project file is non-trivial in size", proj.stat().st_size > 100_000, proj.stat().st_size)

        page2 = await ctx.new_page()
        page2.on("pageerror", lambda e: errors.append("reopen: " + str(e)))
        await page2.goto(APP)
        await page2.set_input_files("#projIn", str(proj))
        await page2.wait_for_timeout(2500)
        counts2 = json.loads(await page2.evaluate(
            "JSON.stringify(FW.S.gates.map(g=>FW.getPop(FW.S.samples[0],g.id).length))"))
        check("population counts identical after reopening the project", counts == counts2, f"{counts} vs {counts2}")
        check("compensation state restored", await page2.evaluate("FW.S.compOn") is True)

        # ---- groups (v1.1)
        await page.evaluate("()=>{FW.S.gates=[{id:'gg1',group:'G1',name:'Cells',parent:'root',type:'rect',x:'FSC-A',y:'SSC-A',pts:[[42000,6000],[88000,34000]]}];FW.S.nextId=2;FW.renderAll();}")
        await page.wait_for_timeout(400)
        check("a default group holds every sample",
              await page.evaluate("FW.S.groups.length === 1 && FW.S.groups[0].members.length === FW.S.samples.length"))

        await page.evaluate("()=>{FW.addGroup('Second');}")
        await page.wait_for_timeout(300)
        check("a new group starts with an empty tree",
              await page.evaluate("FW.dfs().length === 1"), await page.evaluate("JSON.stringify(FW.dfs())"))

        await page.evaluate("()=>{FW.copyGatesTo('G1','G2');}")
        await page.wait_for_timeout(400)
        check("copied gates get fresh ids so the trees stay independent",
              await page.evaluate("(()=>{const ids=FW.S.gates.map(g=>g.id);return new Set(ids).size===ids.length && FW.S.gates.filter(g=>g.group==='G2').length===1;})()"))

        await page.evaluate("()=>{FW.setActiveGroup('G1');FW.S.view.pop='root';}")
        await page.wait_for_timeout(300)
        base = json.loads(await page.evaluate("JSON.stringify(FW.S.samples.slice(0,3).map(s=>FW.getPop(s,'gg1').length))"))
        await page.evaluate("""()=>{const s=FW.S.samples[0];
            FW.S.overrides[s.id+':gg1']={pts:[[50000,9000],[80000,30000]]};
            FW.invalidateGates();FW.renderAll();}""")
        await page.wait_for_timeout(400)
        nudged = json.loads(await page.evaluate("JSON.stringify(FW.S.samples.slice(0,3).map(s=>FW.getPop(s,'gg1').length))"))
        check("a per-sample override moves only that sample",
              nudged[0] != base[0] and nudged[1:] == base[1:], f"{base} -> {nudged}")
        check("the group's own gate is left alone by an override",
              await page.evaluate("JSON.stringify(FW.S.gates.find(g=>g.id==='gg1').pts) === '[[42000,6000],[88000,34000]]'"))

        async with page.expect_download() as dl:
            await page.click("#btnSaveProj")
        gproj = tmp / "groups.fwproj"
        gproj.write_bytes(pathlib.Path(await (await dl.value).path()).read_bytes())
        page3 = await ctx.new_page()
        page3.on("pageerror", lambda e: errors.append("groups reopen: " + str(e)))
        await page3.goto(APP)
        await page3.set_input_files("#projIn", str(gproj))
        await page3.wait_for_timeout(2500)
        check("groups and overrides survive a project round trip",
              await page3.evaluate("FW.S.groups.length===2 && Object.keys(FW.S.overrides).length===1"),
              await page3.evaluate("JSON.stringify({g:FW.S.groups.length,o:Object.keys(FW.S.overrides).length})"))
        reopened = json.loads(await page3.evaluate("JSON.stringify(FW.S.samples.slice(0,3).map(s=>FW.getPop(s,'gg1').length))"))
        check("adjusted counts reopen unchanged", reopened == nudged, f"{nudged} vs {reopened}")

        check("no uncaught JavaScript errors", not errors, errors[:3])
        await browser.close()

    print(f"\n{checks - len(failures)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
