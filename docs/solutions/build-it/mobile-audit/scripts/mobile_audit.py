"""
Mobile responsive audit for GeekShop HQ.
Walks every major page at iPhone 12 viewport (390x844) and saves screenshots
plus a console-log of any horizontal overflow detected.
"""
import asyncio
import json
import sys
from pathlib import Path
from playwright.async_api import async_playwright

PAGES = [
    ("Inbox", "http://localhost:5173/"),
    ("Tickets", "http://localhost:5173/tickets"),
    ("Appointments", "http://localhost:5173/appointments"),
    ("Customers", "http://localhost:5173/customers"),
    ("Money", "http://localhost:5173/money"),
    ("Accounting", "http://localhost:5173/accounting"),
    ("Time", "http://localhost:5173/time"),
    ("MissionControl", "http://localhost:5173/mission-control"),
    ("Settings", "http://localhost:5173/settings"),
]

OUT = Path("/home/byron/projects/geekshop-hq/docs/solutions/build-it/mobile-audit")
OUT.mkdir(parents=True, exist_ok=True)


async def measure(page):
    """Return document scroll width vs viewport width, and any overflowing children."""
    return await page.evaluate("""
        () => {
            const docW = document.documentElement.scrollWidth;
            const winW = window.innerWidth;
            // Find any element wider than the viewport (i.e. causing horizontal scroll)
            const offenders = [];
            for (const el of document.body.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.width > winW + 1 && r.height < 2000) {
                    offenders.push({
                        tag: el.tagName,
                        cls: (el.className || '').toString().slice(0, 80),
                        w: Math.round(r.width),
                        x: Math.round(r.x),
                    });
                }
            }
            return { docW, winW, hOverflow: docW > winW + 1, offenders: offenders.slice(0, 10) };
        }
    """)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            is_mobile=True,
            has_touch=True,
        )
        page = await ctx.new_page()
        results = {}
        for label, url in PAGES:
            try:
                await page.goto(url, wait_until="networkidle", timeout=15000)
            except Exception as e:
                # Some pages have long polling — settle with domcontentloaded instead
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=10000)
                    await page.wait_for_timeout(1500)
                except Exception as e2:
                    results[label] = {"error": str(e2)[:200]}
                    continue
            await page.wait_for_timeout(800)
            shot = OUT / f"mobile-{label}.png"
            try:
                await page.screenshot(path=str(shot), full_page=False)
            except Exception:
                pass
            m = await measure(page)
            # Also check viewport-meta
            results[label] = {
                "url": url,
                "scrollW": m["docW"],
                "winW": m["winW"],
                "hOverflow": m["hOverflow"],
                "offenders": m["offenders"][:5],
                "screenshot": str(shot),
            }
        await browser.close()
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
