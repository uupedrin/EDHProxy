<p align="center">
  <img src="icon.png" alt="EDHProxy icon" width="128" height="128">
</p>

<h1 align="center">EDHProxy</h1>
<p align="center">
  Use your own art (alters, proxies, playmats) on <a href="https://edhplay.com">edhplay.com</a><br>
  and share it with the players in your room who also use EDHProxy.
</p>

<p align="center">
  <a href="../../releases/latest">Download</a> ·
  <a href="#install">Install</a> ·
  <a href="#use">Use</a> ·
  <a href="#how-sharing-works">Sharing &amp; privacy</a>
</p>

> **Unofficial fan project.** EDHProxy is not affiliated with, endorsed or sponsored by EDHPlay or Wizards of the Coast. Magic: The Gathering and its symbols are trademarks of Wizards of the Coast LLC.

## Features

- **Custom art per card.** Upload an image of the whole card (an alter, a proxy) by URL or from your computer, and it replaces that card everywhere on edhplay: your decks, the table, previews and deck covers.
- **A Custom folder in "Change Printing".** Every card keeps a folder with all the arts you have uploaded for it. Pick one, then **Confirm** — just like choosing a printing.
- **Shared in game.** Players in the same room who use EDHProxy see your arts on *your* cards, and you see theirs on *their* cards. Everyone else sees the normal cards.
- **Local names.** Give each art a name to tell them apart. Names stay in your browser.
- **Custom playmats.** Upload your own playmats in edhplay's Settings → Playmats → **Custom**; your opponents with EDHProxy see them too.
- **Custom sleeves.** A **Custom Matte** sleeve in any color, or your own image cropped to the sleeve's shape, in Settings → Card Sleeves → **Custom**.
- **Foil.** Mark any card as foil (custom art or not) from its menu or with the **F** key; it gets the same rainbow sheen Archidekt uses, and players in your room see it too.
- **Follows the site's language.** English, Spanish, Italian, German, French, Portuguese, Japanese and Dutch — the same languages edhplay offers.
- **One-click updates.** A badge on the toolbar icon tells you when there's a new version.

## Install

EDHProxy works in Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi) on Windows, macOS and Linux.

1. Download **edhproxy.zip** from the [latest release](../../releases/latest) and extract it into a folder of your own, for example `Documents/EDHProxy`.
   Avoid system folders such as `AppData` or `Program Files`: the browser won't let the extension update itself there.
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`), turn on **Developer mode**, click **Load unpacked** and pick that folder.
3. Reload any edhplay tabs that were already open.

Everyone you play with needs to install it too to see each other's arts.

## Update

When a new version is out, the extension icon shows a **↑** badge. Click the icon, then **Update now**: a page of the extension downloads the new version from GitHub, saves it into the extension folder and reloads the extension.

The first time, the browser asks you to pick the extension folder (the one you chose in **Load unpacked**) and to allow saving there.

You can also look for a new version right away with **Check for updates** in the popup; when there is one, the button turns into **Update now**.

Some browsers don't let extensions save into a folder (Brave turns this off by default). There, the update page gives you the zip and the steps to update by hand. On Brave you can enable one-click updates at `brave://flags/#file-system-access-api` and restart the browser.

You can also update by hand: download the new zip and extract it over the same folder. The extension notices within a minute and reloads itself.

Nothing is installed on your system and nothing runs outside the browser. The extension only asks GitHub every 6 hours whether there's a new version.

## Use

1. Open one of your decks (`edhplay.com/decks/<id>`), click a card and choose **Change Printing**.
2. Before the printings there's a **Custom** folder. Open it.
3. Click **+ Add**, paste an image URL (https) or choose a file, optionally give it a name, and **Save**.
4. The new art is selected (blue border). Click edhplay's **Confirm** to use it for this card in **this deck**, or **Cancel** to leave things as they were. Tick **Use in all my decks** in the panel to apply it to every deck instead.

Each deck keeps its own choice, so the same card can have different arts in different decks. Deck covers on My Decks follow each deck's choice, and in a game EDHProxy uses (and shares) the choices of the deck you joined with.

In the Custom panel:

| | |
|---|---|
| Green border | the art in use |
| Blue border | the art you selected — click **Confirm** to apply |
| **Original** | back to the printing's normal art (also: click the current printing, then **Confirm**) |
| ✏️ pencil | name or rename an art (only you see names) |
| ✕ | delete an art |

Choosing a different printing and confirming switches the card back to normal art. Arts are edited on deck pages only; in a game they are just shown.

The popup (click the extension icon) shows whether you're in a room and what each player with the extension shares, and lets you export/import your arts. **Manage arts** opens the manager, with three tabs. **Cards** is a grid of every card you uploaded arts for; click one to see its arts and the decks that use each (or "All decks"), and rename or delete them. **Playmats** and **Sleeves** list your custom ones, show which is in use, and let you rename or delete them. Search works on every tab. Deck names show up once you've opened My Decks or the deck with the extension on. Under **Extension** you can **Check for updates** right away or **Clear data** (deletes all your arts, foils, playmats and sleeves; your settings stay).

### Custom playmats

Open edhplay's **Settings → Playmats**. Next to All / Free / Patreon there's a **Custom** tab with the playmats you uploaded. Click **+ Add** to upload one (image URL or a file; wide 16:9 images work best), pick it and click **Save Preferences**. Choosing one of edhplay's playmats and saving switches back. During a game, players in your room with EDHProxy see your playmat on your side of the table.

### Custom sleeves

Open edhplay's **Settings → Card Sleeves** and the **Custom** tab, then **+ Add**:

- **Custom Matte**: pick a color; EDHProxy paints a matte sleeve with it.
- **Image**: paste an image URL or choose a file, then drag it and zoom (slider or mouse wheel) to frame it. The frame has the sleeve's proportions (274×384, like a card) and the picture is cropped to it, like an avatar on Discord.

Pick one and click **Save Preferences**. Your sleeve shows on the backs of your cards (library, hands, face-down cards), and players in your room with EDHProxy see it too. Image sleeves are shared like local files (through litterbox, during the game); matte sleeves only send their color.

### Foil

On your deck page, open a card's menu (right-click or the **⋮** button) and choose **Foil**, or hover the card and press **F**. Do the same again to remove it. Foil applies to that card in that deck only (with or without custom art), and is shared with players in your room like arts are. You can turn the feature off in the popup (**Allow foil**).

## How sharing works

- In a game (`/games/<room>/play` or `/spectate`), EDHProxy joins a channel on [ntfy.sh](https://ntfy.sh), a free public pub/sub service. The channel name is a hash of the room ID.
- It publishes the list of your arts (card + image URL) and receives the other players' lists. Players who join later get the recent history (ntfy.sh keeps it for about 12 hours).
- **Arts only apply to their owner's cards.** EDHProxy reads each card's owner from the game, so if you and a friend play the same card, each copy shows its owner's art.
- **Local files** stay in your browser. During a game, when another player with EDHProxy is in the room and the card is on the table, a temporary copy is uploaded to [litterbox.catbox.moe](https://litterbox.catbox.moe) (deleted after 1 hour) and that link is shared. An upload is reused while it lasts (also after a reload or in the next game) and renewed shortly before it expires. Turn this off in the popup (**Share local files**) to keep local files to yourself.
- **Image URLs** are shared as they are, with no upload. Discord links expire, so prefer hosts like imgur or catbox.
- **Google Drive** share links (`drive.google.com/file/d/…`) work too: EDHProxy turns them into a direct image link. Share the file with **Anyone with the link**, or other players (and even you) won't be able to load it.
- Usernames shown in the popup are read from the game on your computer; they are never sent through the channel. Art names never leave your browser.
- Anyone who knows a room ID could read its channel, so don't use private images.
- You can use another ntfy server (e.g. self-hosted) in the popup under **Advanced**; everyone in the room must use the same one.

## Limitations

- EDHProxy relies on how edhplay currently renders cards (Scryfall images) and on some of its internal data (card owners, player list). If the site changes, the extension may stop working until it's updated.
- On deck covers, which show only the illustration, the custom card is cropped to the art box of a modern frame; full-art or unusual alters may be cropped differently.
- The broad `https://*/*` permission is there so the extension can reach the ntfy server you choose, which can be self-hosted.

## Releasing a new version

For maintainers of this repository:

1. Bump `"version"` in `manifest.json` (e.g. `1.2.0`) and commit.
2. Tag the same version and push the tag:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```
3. GitHub Actions ([release.yml](.github/workflows/release.yml)) builds `edhproxy.zip`, fills in this repository's name and publishes the release. Installed extensions show the update badge within a few hours.

If the workflow fails with a permissions error, enable **Settings → Actions → General → Workflow permissions → Read and write permissions**.

## Credits

- Card images and data from [Scryfall](https://scryfall.com).
- Room sync through [ntfy](https://ntfy.sh); temporary hosting for local files through [litterbox](https://litterbox.catbox.moe).
- EDHProxy is unofficial Fan Content permitted under the [Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
