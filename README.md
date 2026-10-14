# BreakerOps website

Static marketing site for https://www.breakerops.com. Plain HTML and CSS plus one small script. There is no build step.

## Files

| File | What it is |
|---|---|
| `index.html`, `what-we-do.html`, `how-it-works.html`, `contact.html` | The four pages. Each one contains its own header and footer. |
| `assets/css/styles.css` | All styles. The brand colors are at the top. |
| `assets/js/nav.js` | Mobile menu toggle. Without JavaScript the menu stays open. |
| `assets/img/` | Wordmark, social preview image (1200×630), and Apple touch icon. |
| `favicon.svg`, `favicon.ico` | Favicons. |
| `robots.txt`, `sitemap.xml` | Search indexing. The sitemap lists the four pages. |
| `CNAME` | Contains `www.breakerops.com`. Do not edit. |
| `.nojekyll` | Tells GitHub Pages to serve the files exactly as they are. |

## Editing copy

To change copy, open the page file and edit the text. The header and footer are repeated on all four pages, so a change to either one has to be made in every file.

## Local preview

From this folder, run:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. Opening the files directly by double-clicking won't work, because links start with `/` and need a server.

## Publish on GitHub Pages

1. Create a repository such as `breakerops-site` under your GitHub account or organization. A public repo is the simple free option. Keep private material out of it either way.
2. Commit these files to `main`, with `index.html`, `.nojekyll`, and `CNAME` at the root.
3. Go to **Settings → Pages → Build and deployment**. Choose **Deploy from a branch**, then select `main` and `/ (root)`, and save.
4. Set **Custom domain** to `www.breakerops.com` and save. Do this before you change DNS.
5. Verify the domain with GitHub. Go to your account or organization **Settings → Pages → Add a domain**, then add the TXT record GitHub gives you. Use GitHub's exact value and leave the record in place afterward.
6. Once the DNS check passes and the certificate is issued, turn on **Enforce HTTPS**.

## DNS cutover (Namecheap)

This change only moves the website. Email stays on Google Workspace.

1. **Record the current zone first.** Take a screenshot or copy of every record. **Keep** all MX records, the SPF TXT record, DKIM (`google._domainkey`), DMARC (`_dmarc`), and any verification TXT records.
2. Go to **Domain List → Manage breakerops.com → Advanced DNS → Host Records**. If your nameservers point somewhere else, make these changes at that DNS provider instead, and leave the nameservers as they are.
3. Replace the Google Sites `www` record with:

   | Type | Host | Value | TTL |
   |---|---|---|---|
   | CNAME | www | `YOUR-GITHUB-USERNAME.github.io` | Automatic |

   Put only the hostname in Value: no `https://`, no slash, and no repo name. Delete the old Google Sites CNAME so that `www` has exactly one record.
4. Recommended: send the bare `breakerops.com` to `www`. Remove only the website records at `@` (old A/AAAA records, parking, URL redirect), then add:

   | Type | Host | Value |
   |---|---|---|
   | A | @ | 185.199.108.153 |
   | A | @ | 185.199.109.153 |
   | A | @ | 185.199.110.153 |
   | A | @ | 185.199.111.153 |

   Don't add wildcard records, and don't touch MX or TXT records.
5. Wait for DNS to update. It can take up to 24 hours. Check with:

   ```sh
   dig www.breakerops.com CNAME +short
   dig breakerops.com A +short
   ```

## Launch check

The site isn't launched until all of these pass:

- [ ] `https://www.breakerops.com` loads with a valid certificate, and Enforce HTTPS is on.
- [ ] `http://` and bare `breakerops.com` both redirect to `https://www.breakerops.com/`.
- [ ] Each of the four page URLs opens directly, and still works after a refresh.
- [ ] The email links open a new message to the right address.
- [ ] **On a real phone and on desktop**, the whole Google Form shows on the Contact page with no scrollbar inside it. That includes the error messages for blank fields and the thank-you screen after submitting.
- [ ] Send one real test inquiry through the form and confirm the notification email arrives.
- [ ] Workspace email still sends and receives after the DNS change.

## Contact form height

Google doesn't let a website measure an embedded form, so the frame height is set by hand in `styles.css` (look for `.form-frame iframe`): 1900px on narrow phones, 1800px on larger phones, and 1650px on tablet and desktop. These are deliberately generous estimates for a five-question form. If the form scrolls inside its frame, increase the number for that screen size. If you add questions, check again.

If the form can't be made to fit cleanly, a native form through Formspree is the fallback. Switching to it is a separate decision. Don't do it without testing first.
