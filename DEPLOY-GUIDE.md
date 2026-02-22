# How to Deploy Stickr Online — Beginner Guide

This guide assumes you've never deployed anything before. Follow every step and you'll have Stickr live on the internet in about 15-20 minutes.

---

## What You'll Need (All Free)

Before we start, you need 3 free accounts and 1 free tool:

| What | Why | Link |
|------|-----|------|
| **GitHub** account | Stores your code online | https://github.com/signup |
| **Railway** account | Runs your app on the internet | https://railway.app |
| **Git** installed on your computer | Uploads your code to GitHub | https://git-scm.com/downloads |
| **Node.js** installed on your computer | To test locally (optional) | https://nodejs.org |

---

## PHASE 1: Get the Code on Your Computer

### Step 1 — Download the project files

You should already have the `stickr` folder from Claude with these files:

```
stickr/
├── server.js          (the backend server)
├── package.json       (project config)
├── .gitignore         (tells git what to ignore)
└── public/
    └── index.html     (the entire frontend)
```

Save this folder somewhere easy to find, like your Desktop.

### Step 2 — (Optional) Test it locally first

Open a **Terminal** (Mac/Linux) or **Command Prompt** (Windows):

```bash
# Navigate to the folder (change the path to match where you saved it)
cd ~/Desktop/stickr

# Install the dependencies
npm install

# Start the server
node server.js
```

You should see: `Stickr server running on http://localhost:3000`

Open http://localhost:3000 in your browser. You should see the Stickr homepage. Press `Ctrl+C` to stop the server when you're done testing.

---

## PHASE 2: Upload Your Code to GitHub

### Step 3 — Create a GitHub repository

1. Go to https://github.com/new
2. Fill in:
   - **Repository name**: `stickr`
   - **Description**: `P2P file sharing and chat`
   - **Visibility**: Public (or Private, both work)
   - **DO NOT** check "Add a README file" (we already have one)
3. Click **Create repository**

You'll see a page with setup instructions. Keep this page open.

### Step 4 — Push your code to GitHub

Open your Terminal/Command Prompt and run these commands **one at a time**:

```bash
# Navigate to your project folder
cd ~/Desktop/stickr

# Initialize git in this folder
git init

# Add all your files
git add .

# Create your first commit (a "save point")
git commit -m "Initial commit - Stickr P2P file sharing and chat"

# Connect this folder to your GitHub repository
# ⚠️ REPLACE "your-username" with your actual GitHub username!
git remote add origin https://github.com/your-username/stickr.git

# Upload everything to GitHub
git branch -M main
git push -u origin main
```

If it asks for your GitHub password, you may need to use a **Personal Access Token** instead:
1. Go to https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Give it a name, check the **repo** box, click **Generate token**
4. Copy the token and paste it as your "password"

Refresh your GitHub repo page — you should see all your files there!

---

## PHASE 3: Deploy on Railway

### Step 5 — Connect Railway to GitHub

1. Go to https://railway.app and click **Login**
2. Choose **Login with GitHub** (this is the easiest way)
3. Authorize Railway to access your GitHub account

### Step 6 — Create a new project

1. On your Railway dashboard, click **New Project**
2. Choose **Deploy from GitHub repo**
3. Find and select your `stickr` repository
4. Click **Deploy Now**

Railway will automatically:
- Detect it's a Node.js project
- Run `npm install`
- Run `npm start` (which runs `node server.js`)

### Step 7 — Set up networking (make it accessible)

By default, Railway runs your app but doesn't expose it to the internet. You need to add a domain:

1. Click on your deployed service (it might be called "stickr")
2. Go to the **Settings** tab
3. Scroll to **Networking** section
4. Click **Generate Domain**

Railway will give you a URL like: `stickr-production-abc123.up.railway.app`

### Step 8 — Set the PORT variable

Railway assigns a random port via an environment variable. Our app already reads `process.env.PORT`, but let's make sure:

1. In your Railway service, go to the **Variables** tab
2. It should already have a `PORT` variable. If not, add one:
   - Key: `PORT`
   - Value: `3000`

### Step 9 — Wait for deployment

Railway will show a build log. Wait until you see something like:

```
Build successful
Deploying...
```

This usually takes 1-2 minutes.

### Step 10 — Visit your live app! 🎉

Click the domain URL Railway generated (from Step 7). You should see Stickr running live on the internet!

Try it out:
1. Open the URL in one browser tab → Click "Share Files"
2. Copy the share link
3. Open it in another tab (or send to a friend!) → You're connected!
4. Send files and chat messages — they go directly between browsers!

---

## Troubleshooting

### "Application failed to respond"
- Go to the **Deployments** tab and check the build logs for errors
- Make sure `package.json` has `"start": "node server.js"` in the `scripts` section

### WebSocket connection fails
- Make sure you generated a domain (Step 7)
- Railway supports WebSockets natively, no extra config needed

### "Cannot find module 'express'"
- Check that your `package.json` includes express, ws, and uuid in dependencies
- Railway runs `npm install` automatically, so dependencies should install

### Files won't transfer
- Both people need to be connected (green dot says "Connected")
- The sender selects files AFTER a peer has joined
- Very large files may take time — watch the progress bar

---

## How Much Does This Cost?

Railway offers a **free trial** with $5 of usage credits (no credit card required). For a lightweight app like Stickr, this lasts a long time since:
- The server only handles WebSocket signaling (tiny data)
- All file transfers happen directly between browsers (P2P)
- No storage needed

After the trial, Railway's Hobby plan is $5/month with $5 of included usage, which is more than enough for this app.

### Free Alternatives

If you want something completely free long-term:

| Platform | Free Tier | Catch |
|----------|-----------|-------|
| **Render.com** | Free web services | Spins down after 15 min of inactivity (slow cold starts) |
| **Fly.io** | 3 shared VMs free | Slightly more complex setup (requires CLI tool) |
| **Glitch.com** | Free hosting | Sleeps after 5 min, limited resources |

---

## Updating Your App Later

Whenever you make changes to your code:

```bash
cd ~/Desktop/stickr

# Add your changes
git add .

# Commit them
git commit -m "Describe what you changed"

# Push to GitHub
git push
```

Railway automatically re-deploys whenever you push to GitHub. Your app updates within a minute or two!

---

## Custom Domain (Optional)

If you own a domain name (like `stickr.cool`):

1. In Railway → Settings → Networking → **Custom Domain**
2. Enter your domain name
3. Railway gives you a CNAME record
4. Go to your domain registrar (GoDaddy, Namecheap, Cloudflare, etc.)
5. Add the CNAME record pointing to Railway
6. Wait a few minutes for DNS to update
7. Your app is now at your custom domain!
