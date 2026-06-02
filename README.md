# StayLog — Homestay Manager

A lightweight, offline-first Progressive Web App (PWA) for managing your homestay properties. Works on iPhone via Safari — add to Home Screen for a native app experience.

## Features

- **Multiple Properties** — manage any number of homestay properties
- **Booking Management** — track guests, check-in/out dates, status, payments
- **Expense Logging** — log expenses by category per property
- **Dashboard** — today's activity alerts, revenue at a glance
- **Reports** — monthly revenue vs expenses chart, property performance, booking sources
- **Offline Support** — works without internet once loaded
- **Local Storage** — all data stays on your device, private and secure

---

## Deploy to GitHub Pages (5-minute setup)

### Step 1 — Create a GitHub account
Go to [github.com](https://github.com) and sign up for a free account if you don't have one.

### Step 2 — Create a new repository
1. Click the **+** icon (top right) → **New repository**
2. Name it `staylog`
3. Set visibility to **Public** (required for free GitHub Pages)
4. Click **Create repository**

### Step 3 — Upload the files
**Option A — Via GitHub website (easiest):**
1. In your new repository, click **uploading an existing file**
2. Drag and drop ALL the files from this folder:
   - `index.html`
   - `app.js`
   - `sw.js`
   - `manifest.json`
   - `icons/` folder (both icon files)
   - `.github/` folder (with the `workflows/deploy.yml` file)
3. Click **Commit changes**

**Option B — Via Git (if you have Git installed):**
```bash
git init
git add .
git commit -m "Initial StayLog deploy"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/staylog.git
git push -u origin main
```

### Step 4 — Enable GitHub Pages
1. In your repository, go to **Settings** (top menu)
2. Scroll to **Pages** (left sidebar)
3. Under **Source**, select **GitHub Actions**
4. Wait 1–2 minutes for the first deployment

### Step 5 — Your app is live!
Your app will be available at:
```
https://YOUR-USERNAME.github.io/staylog
```

---

## Install on iPhone

1. Open the link above in **Safari** (must be Safari, not Chrome)
2. Tap the **Share** button (box with arrow pointing up)
3. Scroll down and tap **Add to Home Screen**
4. Tap **Add**

The app will appear on your home screen like a native app — full screen, no browser chrome.

---

## Data & Privacy

- All data is stored in your iPhone's **local storage** (Safari)
- Data is **never sent to any server**
- Clearing Safari data will erase your data — consider doing periodic exports
- Each device has its own separate data

---

## Updating the App

To update the app after making changes:
1. Edit the files
2. Commit and push to GitHub
3. GitHub Actions will automatically redeploy (takes ~1 minute)
4. On your iPhone, pull down to refresh, or close and reopen

---

## Tech Stack

- Vanilla HTML/CSS/JavaScript — no build step, no dependencies
- Progressive Web App (PWA) with Service Worker for offline support
- Local Storage for data persistence
- Deployed via GitHub Actions to GitHub Pages
