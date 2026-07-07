"""Mobile audit — detail pages + interaction tests."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("/home/byron/projects/geekshop-hq/docs/solutions/build-it/mobile-audit")
OUT.mkdir(parents=True, exist_ok=True)


async def get_first_customer_id(page):
    """Hit the API and grab a real customer id."""
    return await page.evaluate("""
        async () => {
            const r = await fetch('/api/customers?limit=1');
            const j = await r.json();
            return j[0]?.id || null;
        }
    """)


async def get_first_ticket_id(page):
    return await page.evaluate("""
        async () => {
            const r = await fetch('/api/tickets?limit=1');
            const j = await r.json();
            return j[0]?.id || null;
        }
    """)


async def measure(page):
    return await page.evaluate("""
        () => {
            const docW = document.documentElement.scrollWidth;
            const winW = window.innerWidth;
            return { docW, winW, hOverflow: docW > winW + 1 };
        }
    """)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
            is_mobile=True,
            has_touch=True,
        )
        page = await ctx.new_page()
        results = {}

        # Need to navigate first so we have an origin
        await page.goto("http://localhost:5173/", wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(800)
        cust_id = await get_first_customer_id(page)
        ticket_id = await get_first_ticket_id(page)

        # 1. TicketDetail
        if ticket_id:
            url = f"http://localhost:5173/tickets/{ticket_id}"
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(1500)
            shot = OUT / "mobile-TicketDetail.png"
            await page.screenshot(path=str(shot))
            results["TicketDetail"] = {**(await measure(page)), "url": url, "screenshot": str(shot)}

        # 2. CustomerDetail - tickets tab
        if cust_id:
            url = f"http://localhost:5173/customers/{cust_id}"
            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(1200)
            shot = OUT / "mobile-CustomerDetail-tickets.png"
            await page.screenshot(path=str(shot))
            results["CustomerDetail-tickets"] = {**(await measure(page)), "url": url, "screenshot": str(shot)}

            # 3. CustomerDetail - memory tab
            mem_btn = await page.query_selector('button:has-text("Memory")')
            if mem_btn:
                await mem_btn.click()
                await page.wait_for_timeout(700)
                shot = OUT / "mobile-CustomerDetail-memory.png"
                await page.screenshot(path=str(shot))
                results["CustomerDetail-memory"] = {**(await measure(page)), "url": url, "screenshot": str(shot)}

            # 4. CustomerDetail - invoices tab
            inv_btn = await page.query_selector('button:has-text("Invoices")')
            if inv_btn:
                await inv_btn.click()
                await page.wait_for_timeout(700)
                shot = OUT / "mobile-CustomerDetail-invoices.png"
                await page.screenshot(path=str(shot))
                results["CustomerDetail-invoices"] = {**(await measure(page)), "url": url, "screenshot": str(shot)}

        # 5. Mobile drawer test — visit inbox, tap hamburger, screenshot drawer open
        await page.goto("http://localhost:5173/", wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(1200)
        # Tap the Open menu button by aria-label
        btn = await page.query_selector('button[aria-label="Open menu"]')
        if btn:
            await btn.click()
            await page.wait_for_timeout(400)
            shot = OUT / "mobile-Drawer-open.png"
            await page.screenshot(path=str(shot))
            results["Drawer-open"] = {**(await measure(page)), "screenshot": str(shot)}

        await browser.close()
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    asyncio.run(main())