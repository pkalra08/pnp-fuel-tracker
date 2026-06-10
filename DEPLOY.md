# Fuel Tracker Deploy Guide

Plain steps to make the Canadian Fuel Surcharge Tracker update itself every week, with no developer and without TJ. You can do all of this yourself. It takes about 30 minutes once, then it runs on its own forever.

There are two parts. Part 1 is the data job, which lives entirely in GitHub and runs itself. Part 2 is one edit to the tracker page on partnparcel.com so it reads the data the job produces.

---

## What you are setting up

A free GitHub robot that wakes up every Monday morning, reads the current fuel prices from five free government and carrier sources, calculates every carrier's rate, and saves the result to a file. Your website reads that file. Nobody touches it after setup. If a source ever breaks, the page keeps showing last week's number with a yellow dot, and GitHub emails you so it gets fixed with one AI prompt.

---

## Part 1: The data job (GitHub)

You need a free GitHub account. If you do not have one, create it at github.com.

1. **Create a new repository.** On GitHub, click the plus icon, New repository. Name it something like `pnp-fuel-tracker`. Set it to Public (free Actions minutes). Click Create.

2. **Add the files.** Click "uploading an existing file" or "Add file, Create new file" and add these four files from your Claude Code folder:
   - `fetch-and-build.js` (the data job)
   - `fuel-engine.js` (the rate math, already built)
   - `fuel-rates.json` (the starting data, so the page has something to show on day one)
   - `.github/workflows/fuel-update.yml` (the weekly schedule). To create this one, click Add file, Create new file, and type `.github/workflows/fuel-update.yml` as the name. GitHub will make the folders for you. Paste in the contents of `fuel-update.yml`.

3. **Turn the robot on.** Go to the Actions tab in your repo. If it asks you to enable workflows, click the green button to enable. You will see "Weekly Fuel Surcharge Update" listed.

4. **Run it once by hand to test.** Click "Weekly Fuel Surcharge Update," then "Run workflow," then the green "Run workflow" button. Wait about a minute. Refresh. A green checkmark means it worked and `fuel-rates.json` now has fresh numbers. A red X means a source had trouble; click in to see which one, and that is the one-line fix.

5. **Get the data file's public web address.** Click `fuel-rates.json` in your repo, then click "Raw." Copy that URL from your browser bar. It looks like `https://raw.githubusercontent.com/yourname/pnp-fuel-tracker/main/fuel-rates.json`. You need this for Part 2.

That is the whole data side. It now runs every Monday at 7am Eastern on its own.

---

## Part 2: Point the tracker page at the data (partnparcel.com)

You own the WordPress login, so you can do this without TJ.

1. Log in to partnparcel.com WordPress.

2. Open the Canadian Fuel Surcharge Tracker page for editing. Find the block that holds the tracker (it is the embedded HTML widget TJ added).

3. In the widget's code, there is one line near the top of the script that sets where the data comes from. Change it to the Raw URL you copied in Part 1, step 5. The exact line to change is documented in the updated `fuel-tracker.html` file, marked with a comment that says `DATA SOURCE`.

4. Save and preview. The table should now fill in with the current rates from your GitHub file, and every Monday it will refresh on its own.

If editing the embedded HTML feels risky, the safest path is to replace the whole widget block with the updated `fuel-tracker.html` content, which already has the data-source line and the fetch logic built in. Copy the whole file, paste it into the page's custom HTML block, change the one DATA SOURCE line, save.

---

## What maintenance looks like

Almost none. The job runs weekly on its own. The only time you touch it is if a government agency moves a file, which happens maybe once a year. When that happens:

1. GitHub emails you that the Monday run failed.
2. The tracker keeps showing last week's numbers with yellow dots, so nothing looks broken to visitors.
3. You open the failed run, copy the error, and paste it to Claude with "fix this one source URL in fetch-and-build.js." One prompt, one file change, recommit. Back to green.

No scraper to babysit. No firewall to fight. No subscription to pay.

---

## The five sources, for reference

If you ever want to verify a number by hand, these are where the data comes from. All free, all open.

NRCan Canadian diesel: the source for UPS Standard within Canada, both FedEx Intra-Canada services, and Purolator.

EIA US on-highway diesel: the source for UPS Standard to the US and FedEx Ground International.

EIA Gulf Coast jet fuel: the source for UPS Express services, UPS Domestic Express, FedEx Express International, and Loomis Worldwide. This is the same EIA series UPS and FedEx use themselves.

Canpar public endpoint: the exact rate for Canpar Domestic, which also sets Loomis Domestic because they share a rate table.

Canada Post page: the three Canada Post service rates, read straight from their published page.
