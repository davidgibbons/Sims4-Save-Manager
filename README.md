# Sims 4 Save Manager

A desktop app for Windows and macOS that backs up The Sims 4 saves, adds notes, and restores earlier backups while keeping your current files.

## Using the app

The app has three tabs:

- **My game** shows whether automatic backups are working, the last completed backup, and **Back up now** for an immediate copy.
- **Saved games** contains **Backups** of your game and **Imported saves** brought in from elsewhere. Choose an item to see its details and actions.
- **Settings** holds locations, automatic-backup preferences, start at sign-in, and app updates.

Install the Windows `.exe` (or extract a Windows app ZIP and run `Sims 4 Save Manager.exe`), or open the Mac `.dmg` and drag the app to Applications. For first setup:

1. Open **Settings** and use **Find my saves**. Choose the location The Sims 4 actually uses. A single detected folder is selected automatically on first setup; **Choose…** handles custom locations.
2. Review the **Save location**: this is where The Sims 4 reads and writes while you play.
3. Review the **Backup location**: this is where the app keeps copies you can restore later. **Use recommended location** chooses `%LOCALAPPDATA%/Sims 4 Save Manager/Backups` on Windows or `~/Library/Application Support/Sims 4 Save Manager/Backups` on Mac, outside the standard cloud-sync folders. Changing the location does not move older copies.
4. Turn on **Back up my saved changes automatically**. Choose **Start this app when I sign in** in an installed build to enable protection after signing in. Closing the window keeps automatic backups running in the tray/menu bar; **Quit** there stops them. macOS may ask you to approve the login item in System Settings.

The app backs up saved files on disk; it does not make the game save unsaved progress. Protection runs only while the app is running and the computer is awake. Mods, Tray library items, screenshots, and other game folders are outside this save-only workflow.

## Importing and trying saved games

1. Open **Saved games → Import saves…** and choose a folder or attached drive containing older saves. Nested folders, `.save` files, `.save.verN` recovery files, and renamed saves are included.
2. Review the preview and select the files to import. Verified copies are placed in `Imported saves` inside your Backup location; originals remain unchanged. Identical files are skipped. Labels and notes follow file contents, even when names or locations change. The imported library remains available after the source drive is disconnected.
3. Browse **Imported saves** and search. The menu next to the search box picks what to search:
   - **Families, Sims & notes** (default) searches your label and notes, the save name, household and Sim names, and the date.
   - **Houses & lots** searches lot names, neighborhoods, and lot descriptions.

   File paths, hashes, and IDs are not searched. Each matching row says what matched, such as `Matches Family: Lightfeather`. Backups are searched by note and date.

   Select an item for a short preview of the active household, a few members, and its home lot when those are recorded. **Browse all houses and lots** comes next, with modified-lot, total-lot, and neighborhood counts in its collapsed heading. The active household's home and any lots matching a Houses & lots search appear nearby. Expand **Browse all houses and lots** to filter every recorded lot. **Modified lots only** is checked by default; uncheck it to include unmodified and unknown lots. When it hides a house-search match, a hint and **Show hidden matches** button let you reveal the result. Open a lot to see its saved image when available, neighborhood, recorded bedroom and bathroom counts, linked household, description, and lot ID. The list shows 40 lots at a time, and lots matching your search come first. Its counter uses the save's full total, such as `Showing 8 of 338 lots`, even when filtered. Bedroom and bathroom counts are what the save recorded, not an inspection of the build. Lot size, value, type, floor plans, and live 3D rendering are not provided. The **Households and Sims** heading likewise shows player-household and total-household counts. Expand it for members, life stages, funds, descriptions, and other households. **Player households only** is also checked by default; uncheck it to see everyone. Its counter likewise shows the full household total. Expand **Save details and packs** for locations, game versions, recorded pack requirements, and file dates. **Edit label and notes** lets you give it a memorable name, record what you found, and mark it as tried. Choose **Save notes** to persist edits. Switching tabs or receiving background updates keeps unsaved drafts in the window; closing the app does not save those drafts.
4. Close The Sims 4, then choose **Try this save** and confirm. The app preserves your current game before switching. Open The Sims 4 and choose **Load Game** to inspect the imported save. If the live Save location is cloud-synced, pause syncing during trials: the app cannot stop OneDrive from changing the live folder.
5. The trial banner stays visible in every tab. After closing the game, choose **Return to my game** to restore the set from before the first trial, or **Keep this save** to make the trial your current game. Keeping creates a verified backup of current trial progress before ending the trial; the previous game stays in Backups. Folder changes and ordinary backup restores are blocked until you return or keep.

Each switch also preserves the files being replaced in `Restored Backups`. The original return point survives multiple trials and app restarts through the `archive.json` journal in the app's settings directory. A copied `.save.verN` file is renamed to `.save` only when preparing the trial. Renamed saves without a known slot use trial slot `00000002`.

Existing settings, notes, backup formats, and active trial return points carry forward. Previously scanned external folders are not silently copied: use Import saves to add them to the managed library. Imported records are an additive extension to the existing archive journal; older journals load with an empty imported library.

Inspection reads supported DBPF metadata without changing save files. The active household is matched by its recorded ID; it is never inferred from the first household or a familiar name. Other households and Sims can include NPCs. Missing fields and unrecognized life stages remain unknown. Recorded pack requirements do not prove packs are installed or identify missing mods. Internal timestamps are retained under **Technical details**, but are not converted into dates until their format is verified. File dates can reflect copying; readable metadata does not prove a save is playable.

Lot status comes from the building resource's explicit `is_modified_from_lot_template` flag: true is **Modified**, false is **Unmodified**, and a missing, unreadable, ambiguous, or mismatched record is **Unknown**. Unknown does not mean stock; Modified does not identify who made the change or distinguish a renovation from a placed Gallery build. The modified-only filter excludes unknown lots.

The household filter uses the explicit `is_player` flag. It can include premade families the player took over and does not establish who created or modified a family. Missing or invalid flags remain unknown and are excluded by the player-only filter. The separate `is_unplayed` flag is shown as recorded play history when available. Refresh older imports to read these flags. Filter choices are remembered per save while the window is open.

Lot previews are the game's saved JPEG thumbnails, matched by exact 64-bit lot ID. Opening a lot reads its preview on demand from the managed imported copy after verifying the save hash. Supported transparency masks are applied, and empty margins are cropped for display. Images are kept only in the window, not in the archive journal. Fully transparent thumbnails show “No visible house preview was saved for this lot” without a retry button. Missing or invalid images leave the lot details usable and show an unavailable-preview message. A saved preview can be old or small and is not a fresh render of the current building.

Each imported-save row lists its recorded lot and neighborhood counts, such as `338 Lots, 12 Neighborhoods`, then summarizes the total Sims recorded in the world, recorded pack requirements (excluding the base game), and combined household funds in compact form, such as `319 Sims · 47 packs · §6.2M total`. The Sim count includes premade and generated Sims. Funds total all recorded households, not just the active family; hover over the summary for the exact amount. Unknown values are labeled, and incomplete money totals use `≥` to show that only the known funds were added.

In **Imported saves**, the top **Refresh** button rereads details for all imported saves from their stored copies and shows progress. **Save details and packs → Refresh details** refreshes just the selected save. The source drive is not needed. Refresh verifies each copy against its imported hash and preserves its original file date, label, notes, and any trial return point. Unavailable, changed, or unreadable copies keep their previous details; other saves continue refreshing, and a summary identifies any failures. Older archive journals remain compatible without an automatic rescan. Refresh older imports to add lot details, modification flags, and preview availability. Original paths, slot numbers, hashes, recorded IDs, and parser details are available under **Technical details**.

Scans skip symbolic links and are limited to 1,000 files, 10,000 directory entries, and 12 folder levels. Metadata inspection is limited to 128 MB files, 64 MB decompressed resources, three seconds per file in a worker, and details for 1,000 households, 10,000 Sims, and 5,000 lots. Saved preview resources are limited to 2 MB and images up to 2048 × 2048 pixels; animated transparency masks are rejected. The app reports when metadata detail limits are reached. Larger or unsupported saves still get file facts and can be imported and tried; use a smaller source folder if the scan limit is reached.

## Automatic protection

The app polls every five seconds and waits at least ten seconds for a changed set of files to remain stable. Every accepted snapshot is checked against both the source and copied bytes before it is listed as complete. A new snapshot is created only after a detected change or when the most recent local snapshot needs replacing. A fresh session creates a new initial protective snapshot.

Automatic protection rejects known cloud-sync destinations (OneDrive, iCloud Drive on Mac and Windows, Dropbox, and Google Drive) and overlapping save/backup folders. Missing files, unrecognized/empty save headers, unstable sources, access failures, and disk-full errors are reported in the app and, where supported, through desktop notifications. Older snapshots are never automatically deleted. If files intentionally disappear, review the folder and turn protection off and on to accept the current set. Swaps performed through this app are acknowledged automatically.

Keep enough free space for the snapshots. An external-drive copy is still useful for disk failure: local snapshots protect captured versions from cloud-sync mistakes, not a failed computer or files lost before the first backup.

Installers are produced by the **Build desktop installers** GitHub Actions workflow. End users do not need Node.js or Python. Current builds are unsigned and unnotarized previews. Windows SmartScreen or macOS Gatekeeper may warn or block installation. Mac apps use a local ad-hoc signature for Apple Silicon compatibility; it does not establish a verified publisher. No paid signing credentials are required for these previews.

## In-app updates

Installed builds check for new stable releases on startup. **Check for updates** checks again. In Settings, choose **Download update**, then **Restart and install** when ready. Downloads show progress; normal app quit does not install an update. Installation is blocked during a backup or restore, and new save operations are blocked while an update is installing. Updates replace the app without moving your saves, backups, or per-user settings.

Updates come from this repository's public GitHub releases. Drafts and prereleases are excluded. Check and download errors appear in the app. Installer startup errors are reported when the updater exposes them. When no release is published, the app reports that no update release is available. Development runs with `npm start` do not check for updates.

Windows updates require the NSIS-installed app; the standalone Windows ZIP is for manual upgrades. Mac updates require a properly signed app installed in a writable location such as your user's Applications folder. Unsigned Mac builds cannot complete an in-app update. Existing builds without this updater need one manual installation of an updater-enabled release.

## Your saves and backups

- Backups retain the Python V2 format: one timestamped folder per backup, with an optional `backup-note.txt`. Select your existing backup folder to use old backups.
- All regular files directly inside the save folder are copied, including `.save.ver*` versions, except the reserved `backup-note.txt` metadata file. Subfolders are left untouched. Symbolic links and special files are rejected.
- A failed or unverified backup is not listed as a completed backup.
- Before restoring, the app stages the replacement files and copies current files into `Restored Backups/<timestamp>` inside your backup folder. A failed restore attempts to recover the originals; the recovery copy remains available even if rollback fails.
- To recover those original files manually, close the game and copy them from the reported recovery folder into your saves folder. The recovery collection itself is excluded from the main backup list.
- Do not edit the save or backup folders during an operation. A forced shutdown can interrupt a restore; recover from `Restored Backups` if needed.
- Settings are stored in Electron's per-user app-data directory: `%APPDATA%/Sims 4 Save Manager` on Windows or `~/Library/Application Support/Sims 4 Save Manager` on macOS. Python settings are not imported; choose your folders once in the new app.

## Development

Requires Node.js 24 and npm. The GUI uses Electron and plain HTML/CSS/JavaScript; Python is not required. `@s4tk/compression` supplies the legacy resource decompressor. Save inspection is read-only; binary container and protobuf field layouts follow the [Sims 4 Toolkit](https://github.com/sims4toolkit/models) and [save-reader schema](https://github.com/gametimedev/ts4-save-data-reader/blob/main/SaveGameReader/Proto/FileSerialization.cs). Life-stage codes follow the [game's Age enum](https://github.com/jolieschae/phase3project/blob/main/game/decompile/simulation/sims/sim_info_types.py); known pack names use the [pack ID reference](https://thesims4moddersreference.org/reference/pack_data/). Unmapped pack IDs stay visible with an unknown name. Parser tests use synthetic saves; local read-only checks can additionally use imported copies without adding personal saves to the repository.

```sh
npm ci
npm test
npm start
```

```sh
npm run pack        # Build an unpacked app for the current machine
npm run dist:mac    # Build Intel and Apple silicon DMGs on macOS
npm run dist:win    # Build x64 and ARM64 Windows installers on Windows
```

Builds are written to `dist/`. electron-builder converts `src/assets/icon.png` into the Mac `.icns` and Windows `.ico` icons; `npm start` on macOS shows the same icon in the Dock. The CI workflow uses native Windows and macOS runners and runs the tests before packaging. Main-branch and PR builds upload test artifacts. Release-please maintains a version/changelog PR from Conventional Commits on main. Merging that PR creates a tag and draft release, then the same workflow builds its installers and update files. Manual version tags also build a draft release. Publishing remains a separate manual action after both platforms pass. The Electron renderer has no Node.js access; folder selection, file operations, and update actions run through a restricted preload interface in the main process.

Windows app ZIPs can also be built with electron-builder's `--win zip --x64 --arm64` options. Creating the NSIS `.exe` installer on an Apple silicon Mac may fail if its installer compiler cannot run; use the native Windows CI job for that installer.

## Publishing updates

Ordinary pushes do not publish releases. Use `feat:`, `fix:`, and other Conventional Commit subjects so release-please can prepare the next version, `package-lock.json`, and changelog in a release PR. The initial version baseline is 3.2.0; the bootstrap commit excludes the old Python-only history.

The release-please job uses the repository's `GITHUB_TOKEN` by default. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. An optional `RELEASE_PLEASE_TOKEN` secret can supply a fine-grained token with repository contents, issues, and pull-request write access if CI must start automatically on the bot-created release PR. With the default token, GitHub suppresses those PR-triggered runs; run **Build desktop installers → Run workflow** against the release PR branch before merging it. Release builds are invoked directly in the same workflow, so they do not depend on bot-created tags triggering another run. See the [release-please token documentation](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).

Current releases are **unsigned previews**. The workflow applies an ad-hoc Mac signature without hardened runtime or notarization, and builds Windows installers without a publisher certificate. No signing secrets are read by these builds. Reintroducing trusted signing later requires Apple Developer ID/notarization and a Windows signing provider, plus update verification on both platforms.

1. Review the release-please PR's proposed version and changelog and validate that branch.
2. Merge the release PR. CI checks the generated tag matches the app version and uploads installers, Mac ZIPs, blockmaps, and `latest*.yml` metadata to an unpublished preview draft.
3. Review the completed draft, add installation notes, and publish it as a **prerelease**, keeping it out of the stable update feed. Publish only after both platform builds pass. The workflow refuses to overwrite a published release.
4. For an existing unpublished tag, run **Build desktop installers → Run workflow** on `main`, setting **release_tag** to the existing tag (for example, `v3.3.0`). The workflow builds the tagged source with the current unsigned packaging settings and updates only its draft. Leaving the field empty produces test artifacts only. Do not move or recreate the version tag.

On macOS, move the app to Applications and try opening it. If macOS blocks it, use **System Settings → Privacy & Security → Open Anyway** for the downloaded app. On Windows, SmartScreen may offer **More info → Run anyway**. Only proceed for an installer you obtained from this repository. Managed devices may prevent these overrides. These previews require manual installation and upgrades; the app excludes prereleases from update checks, and unsigned Mac apps cannot complete in-app updates.

Keep the generated update filenames and metadata together; do not hand-edit checksums or omit the Mac ZIP files. The updater verifies download checksums and uses the platform's signing checks. End-to-end update installation requires two signed versions and a published release; unit tests use a simulated update provider and never install software.

The original `sims_save_manager_v2.py` and `Sims Save V1/` remain available as legacy versions.

## License

MIT, as declared by the original project.
