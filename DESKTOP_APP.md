# Alpha desktop — getting it, signing in, and how it updates

Alpha runs in two places. The **web app** is a browser tab and always shows
whatever was last deployed. The **desktop app** is a Windows program you
install, and it is the only one that can run agents, because those need a git
checkout and the AI CLIs on your own machine.

This document is for two audiences. Everything up to *Publishing a release* is
for anyone using Alpha; from there on it is for whoever cuts releases.

---

## 1. Getting the app

Sign in to the web app, then press **Desktop App** on the developer screen. The
download starts immediately.

There is no public link, and that is deliberate. `alpha-desktop` is a private
repository, so an anonymous browser asking GitHub for the installer gets a 404.
The backend fetches it **with your own GitHub token** and streams it back
(`GET /api/download/desktop`), which means GitHub decides whether you may have
it — not Alpha. Somebody outside the organisation gets nothing, and there is no
URL that could leak.

You get `Alpha-Setup-<version>.exe`, about 93 MB. Run it. It installs to
`%LOCALAPPDATA%\Programs\Alpha` and needs no administrator rights.

### Windows will warn you, and that is expected

You will see **"Windows protected your PC"**. Click **More info**, then
**Run anyway**.

Alpha carries no code-signing signature, so SmartScreen has no publisher to
attribute the file to. That is a statement about the certificate, not about the
file. Removing the warning means buying a code-signing certificate — a few
hundred a year — and until then every release shows it.

If you want to confirm you have the real file, every release page lists a
SHA-256 for each installer. Compare it:

```powershell
Get-FileHash Alpha-Setup-2.0.5.exe -Algorithm SHA256
```

### You do not need anything else installed

The installer bundles the GitHub CLI, so there is nothing to install first and
nothing to configure. You do not need to clone a repository, and you do not
need a `.env` file — the app's settings are baked into the installer when it is
built.

---

## 2. Signing in

On first launch Alpha asks you to sign in to GitHub. It shows a short code;
open <https://github.com/login/device>, enter it, and approve. The app notices
by itself and continues.

**Alpha signs in as its own account, not your machine's.** Until 22 September
2026 it read whatever `gh auth login` had been run as in your terminal, which
meant the app could change identity underneath you, a shared machine could not
say which person Alpha was, and signing out of Alpha ran `gh auth logout` —
logging your whole machine out of GitHub.

Now Alpha holds a token of its own, kept in `~/.alpha/github-credential.json`
with owner-only permissions. Your terminal's `gh` login is untouched, and
signing out of Alpha forgets only Alpha's token.

The GitHub CLI still does the work — cloning, pushing, opening pull requests —
but it is handed Alpha's token, so everything happens as the account you chose
in the app.

> Running Alpha from a checkout instead of installing it? Then it falls back to
> your machine's `gh`, so you do not have to complete a device flow to run what
> you are editing. Only installed copies require the in-app sign-in.

---

## 3. How updating works

**You do not have to do anything.** Alpha keeps itself current.

| When | What happens |
| :--- | :--- |
| On launch | Checks for a newer release |
| 5 minutes after launch | Checks again, in case the first attempt hit a flat network |
| Every 6 hours | Checks again, for a machine left open all week |
| A newer version exists | Downloads it in the background, silently |
| Download finishes | Asks you: **Restart now** or **Later** |
| You choose Later | Installs the next time you quit Alpha |

The download is silent and the restart is always your choice, because Alpha
spawns agents that write to a git checkout. Restarting underneath one would
leave a half-finished run and a branch nobody expected.

### Asking for an update yourself

**Settings → Workspace General → Check for updates.** It reports what it found:
already current, downloading, or why it could not check. Useful when you know a
release exists and would rather not wait.

### If an update seems not to arrive

1. **Check the version.** Settings shows what you are running; compare it with
   the latest release. They may already match.
2. **Quit Alpha completely and relaunch.** A downloaded update installs on quit.
   Leaving the app open for days is the one state where an update sits waiting.
3. **Read the log.** `%APPDATA%\Alpha\logs\main.log` records every check,
   download and failure, from version 2.0.3 onward.
4. **Check you are signed in.** Releases are private, so a check needs a
   GitHub token. Without one, updates are skipped and the log says so.

The staged installer lives in `%LOCALAPPDATA%\alpha-desktop-updater\pending`.
A file there means the check worked and it is waiting for you to quit.

### The portable build does not update itself

Each release also has `Alpha-Portable-<version>.exe`, which runs without
installing. It cannot self-update — only the installed version can. Use it for
a quick look, not as your daily copy.

---

## 4. Publishing a release

*From here on, this is for whoever maintains Alpha.*

One command, from `alpha-desktop`, on a clean `main`:

```bash
npm run release
```

It refuses if the version is already released — an update is only offered for a
*higher* version, so a re-published tag reaches nobody. Raise `version` in
`alpha-desktop/package.json` first.

It then builds the frontend and backend, stages them, packages the installer,
publishes a GitHub release, and writes the release notes with a SHA-256 for
each artifact. Expect 10–20 minutes, most of it silent compression. That silence
is not a hang.

### Commit before releasing, not after

The build compiles whatever is in your working tree. Releasing first produces a
published binary whose source is on nobody's branch. Merge to `main`, pull, then
release — the tag then points at code you can check out.

### What a release must contain

Four files, and `latest.yml` is the one that matters most:

| File | Why |
| :--- | :--- |
| `Alpha-Setup-<v>.exe` | the installer |
| `Alpha-Setup-<v>.exe.blockmap` | lets the updater download only changed chunks |
| `latest.yml` | **what the updater reads to learn a version exists** |
| `Alpha-Portable-<v>.exe` | no-install build |

Attaching installers by hand and forgetting `latest.yml` produces a release that
looks complete and updates nobody. That is the whole reason `npm run release`
exists rather than a manual upload.

### A frontend change still needs a desktop release

The web app and the desktop run the *same* renderer code, but the browser pulls
it fresh on every load while the desktop has a frozen copy from build time.
Merging a frontend fix updates the web app by itself and changes nothing on an
installed desktop until the next release.

### Configuration this depends on

| Where | Setting | Purpose |
| :--- | :--- | :--- |
| Render | `ALPHA_DESKTOP_REPO` | which repository holds the releases; without it the Download button reports that this deployment offers no desktop app |
| GitHub App | **Enable Device Flow** and configure the OAuth callback | device flow is the standalone fallback; hosted OAuth is required for targeting a remembered profile |
| Build machine | `ALPHA_CLOUD_API`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ALPHA_ORG` in `alpha-be-main/.env` | baked into the installer; `ALPHA_CLOUD_API` is required for account-specific profile sign-in |

See [CONFIGURATION.md](CONFIGURATION.md) for the full reference.

---

## 5. What changed on 22 September 2026

Six releases in one evening, starting from an installer that did not exist.

| Version | What it brought |
| :--- | :--- |
| **2.0.0** | First release. `npm run release` publishes in one command; the backend streams the installer from the private repository using the caller's own GitHub token |
| **2.0.1** | The Alpha logo as the application icon, in six sizes so Explorer has the right one for lists, the desktop and tiles |
| **2.0.2** | Removed the "Desktop App" button from inside the desktop app, and removed joining a workspace by invite code |
| **2.0.3** | Alpha's own GitHub sign-in; a Settings update check that actually checks; update logging |
| **2.0.4** | Updater reads Alpha's sign-in rather than the machine's `gh`, and a missing token no longer disables updates for the session |
| **2.0.5** | An installed app signs in instead of borrowing the machine's account |

Three things also changed outside the desktop app:

- **Release pages explain themselves.** Every release now carries install
  instructions, says why SmartScreen appears, and lists SHA-256 checksums —
  because an empty release page beside a security warning reads as confirmation
  that something is wrong.
- **Joining a workspace by invite code is gone**, through every layer including
  the database column. A project manager puts people in a workspace, against a
  name. A code names nobody, outlives the message it was pasted into, and lets
  whoever holds the string decide the staffing.
- **The desktop no longer depends on your machine's GitHub account**, described
  in §2 above.

### Two bugs worth remembering

**The updater authenticated with the machine's `gh`.** When the app stopped
depending on that account, updates silently died for anyone who signed in
through the app instead — no error, no prompt, just a version that never moved.
It worked on the maintainer's machine, where `gh` was signed in, and would have
been dead for every teammate. Decoupling from a dependency means auditing
everything that used it, including the parts in another process.

**A fallback answered a product question.** The daemon falls back to the
machine's `gh` when Alpha holds no credential, so that running from a checkout
does not require a device flow. Nothing distinguished a checkout from an
installed app, so every install took the fallback and opened straight onto the
board as whoever the terminal was — reinstating exactly what the sign-in
replaced. A fallback that looks like error handling can quietly decide
behaviour the feature existed to settle.
