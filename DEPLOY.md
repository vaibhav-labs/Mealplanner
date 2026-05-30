# Deploy guide — git + auto-deploy

The local git repo is already created and committed. Because of a sandbox
permission quirk, two stale lock files need removing before git will work on
your Mac, and the GitHub + Netlify connection needs your accounts (I can't log
in as you). Here's the one-time setup — after this, every change auto-deploys.

## 1. Clear the two stale lock files (one command)

Open Terminal and run:

```
cd ~/Documents/mealplanner
rm -f .git/HEAD.lock .git/objects/maintenance.lock
git status
```

`git status` should say "working tree clean". You're good.

## 2. Create a GitHub repo

1. Go to https://github.com/new
2. Name it `mealplanner` (or anything). Keep it **Private** if you don't want
   it public — your Supabase publishable key is in the code, which is fine to be
   semi-public, but private is tidier.
3. **Don't** tick "Add a README" (the repo already has one).
4. Click **Create repository**. GitHub shows you a URL like
   `https://github.com/YOURNAME/mealplanner.git`.

## 3. Push your code

Back in Terminal (replace the URL with yours):

```
cd ~/Documents/mealplanner
git branch -M main
git remote add origin https://github.com/YOURNAME/mealplanner.git
git push -u origin main
```

It'll ask you to authenticate with GitHub the first time (browser or token) —
that's the step only you can do.

## 4. Connect Netlify for auto-deploy

Your current Netlify site was made by drag-and-drop, which isn't linked to git.
To get auto-deploy:

1. Go to your site in the Netlify dashboard
   (`animated-brigadeiros-bf4a10.netlify.app`).
2. **Site configuration → Build & deploy → Continuous deployment →
   Link repository** (or "Link site to Git").
3. Choose **GitHub**, authorize Netlify, pick your `mealplanner` repo.
4. Build settings: leave the build command **blank** and publish directory **`.`**
   (the app is a static `index.html`, nothing to build).
5. Save.

Done. From now on, whenever you `git push`, Netlify rebuilds and deploys
automatically — same URL.

## Your everyday workflow after setup

When you (or I) change something:

```
cd ~/Documents/mealplanner
git add -A
git commit -m "describe the change"
git push
```

...and Netlify deploys it in ~30 seconds. No drag-and-drop ever again.

## Note on what's committed

The Supabase URL + publishable key are in `index.html` / `script.js`. The
publishable key is designed to be in client code (Supabase says it's safe to
share publicly), so committing it is fine. Never commit the **secret** key —
it's not in any of these files.
