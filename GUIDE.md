# How to resize photos to 3000 × 3000

This is the short version. Three clicks, and you're done.

**The link:** _(paste the tool's URL here once it's deployed)_

---

## Before you start

Open the link in **Microsoft Edge** or **Google Chrome**.

It works in Firefox and Safari too, but there you'll get a `.zip` file to unpack
yourself instead of a tidy folder. Edge is already on every company Windows
laptop, so it's the easy choice.

---

## The three steps

**1. Choose your folder**

Click **Choose folder…** and pick the folder with your photos in it — for
example `3320`. You can also just drag the folder onto the page.

Windows will ask you to confirm you're letting the page see that folder. Click
**View files** / **Edit files**. It asks once, and only about the folder you
picked.

**2. Check the numbers**

The tool tells you what it found:

> Found **214 images** in `3320`. 3 files skipped.
> They'll be written to `3320/resized/`.

If the count looks wrong, stop and check you picked the right folder. Nothing
has been changed yet at this point.

Then click **Resize 214 images**.

**3. Wait for it to finish**

You'll see a progress bar. A few hundred photos usually takes a minute or two.
Keep the tab open and your laptop awake while it runs — you can use other apps.

When it's done you'll get a summary. Your resized photos are in a new folder
called **`resized`** inside the folder you picked.

---

## Things worth knowing

**Your photos never leave your computer.** Nothing is uploaded anywhere. The
resizing happens inside your browser, on your own machine — which is also why
it keeps working if your internet drops mid-batch.

**Your original photos are not touched.** They stay exactly where they were,
unchanged. The tool only ever adds a new `resized` folder. If something looks
wrong, your originals are still there.

> ⚠️ This is different from the old process, which moved originals into a
> `Done/original` folder. This tool leaves them alone — you file them yourself.

**Photos aren't cropped — they're stretched.** Every image comes out exactly
3000 × 3000. A photo that wasn't square to begin with will look squashed or
stretched. That's intentional and matches what we've always done.

**Filenames stay the same.** `CARAMELCAFÉ.jpg` comes out as `CARAMELCAFÉ.jpg`.

---

## When something looks off

**"3 files skipped"** — The tool lists which ones and why. Usually they're
`.tif` or `.heic` files, which web browsers can't open. Those need doing the old
way, or converting to JPEG first.

**A file failed** — That usually means the file is damaged. The rest of the
batch still finished; only the named file needs another look.

**No "Choose folder" button, just a "Select files" box** — You're in Firefox or
Safari. Either switch to Edge, or carry on: you'll get a `.zip` at the end that
you right-click → **Extract All**.

**It won't let me pick the folder** — Make sure you're picking a *folder*, not
the files inside it.

**Something else** — Tell _(name / channel — fill this in)_, and say which
folder you were working on and what the screen said. A screenshot of the
summary helps.
