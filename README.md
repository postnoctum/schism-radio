# Schism radio

The guild jukebox at radio.skzm.org. It's a Node server with SQLite, deployed on Railway from GitHub.

The page loads `site.js`, the logo, and the favicon from skzm.org. Changing the Discord invite in skzm.org's `site.js` also updates the banner here, with no redeploy.

## Deploy on Railway

1. **Make a repo.** Push the contents of this folder to a new GitHub repo, for example `postnoctum/schism-radio`.
2. **Create the service.** In Railway, create a New Project, choose Deploy from GitHub repo, and pick the repo. Railway detects Node and runs `npm start`.
3. **Add a volume.** Attach a volume to the service and mount it at `/data`. The app finds it automatically through `RAILWAY_VOLUME_MOUNT_PATH`, so there's nothing to configure. **Without a volume, accounts and the library are wiped on every deploy.**
4. **Test it.** Under the service's Networking settings, generate a Railway domain and open it to check that the radio loads.
5. **Add the custom domain.** Also under Networking, add `radio.skzm.org`. Railway shows a CNAME target, and sometimes a TXT record for verification.
6. **Add the DNS records at SiteGround.** In Site Tools, open Domain → DNS Zone Editor for skzm.org and add:
   - a **CNAME** with name `radio`, pointing at the target Railway gave you
   - the **TXT** record, if Railway showed one
7. **Create the admin account.** Once `radio.skzm.org` loads, create an account right away. **The first account created becomes the admin.**

Optional settings:
- Set the health check path to `/healthz`.
- Set a usage limit in Railway's billing settings.

## Run it locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000. Data is stored in `./data`.

## How the radio picks the next song

1. **Play Next:** songs someone bumped to the front.
2. **Queue:** songs people queued, in the order they were added.
3. **New songs:** anything in the library that has never played, oldest first.
4. **Shuffle:** every song plays once before any song repeats, then the library reshuffles.

The station only advances while at least one person has pressed **Tune in**. If everyone leaves, it holds its place, so new songs aren't used up playing to an empty room.

The station learns each song's length from the first listener who plays it and remembers it after that. If a video gets taken down or blocks embedding, the station skips it automatically.

## Roles

| | Guest | Member | Trusted | Officer | Admin |
|---|---|---|---|---|---|
| Listen | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add songs, queue songs | | ✓ | ✓ | ✓ | ✓ |
| Play next | | | ✓ | ✓ | ✓ |
| Skip, remove anyone's queued songs | | | | ✓ | ✓ |
| Delete from library, manage people | | | | | ✓ |

These are defaults. From **Settings** on the radio page, admins can change any of them, along with how many songs each role can have waiting in the queue at once. Unchecking **Listen** for Guest makes the radio members-only.

A few more rules:
- Anyone can sign up. New accounts start as Guest until an officer promotes them.
- People can always remove songs they queued themselves.
- Five wrong passwords lock that username out for five minutes.
- The station always keeps at least one admin.

## Files

```
server.js        HTTP server, static files, WebSocket connections
station.js       Accounts, permissions, library, queue logic, sync
public/          The radio page (index.html, radio.js, style.css)
```
