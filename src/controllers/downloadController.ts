import { Readable } from 'node:stream';
import { Request, Response, Router } from 'express';

import { ALPHA_DESKTOP_REPO } from '../config/env.js';
import { route } from './asyncRoute.js';
import { githubApi, tokenForThisRequest } from '../services/githubApi.js';
import { logError, logInfo } from '../utils/logger.js';

export const downloadRouter = Router();

/**
 * The desktop app, to whoever is signed in.
 *
 * The repository is private, so a download link cannot be a link: an anonymous
 * browser hitting GitHub gets a 404, and a public release would put the
 * installer -- which carries this deployment's settings -- in front of anyone
 * who found the URL. So the cloud fetches it with the signed-in person's own
 * token and streams it back. They can see the repository or they cannot, and
 * GitHub decides that, not this route.
 *
 * What it used to serve was a zip file at a path relative to the daemon, which
 * exists on nobody's Render instance: the button answered 404 for every
 * developer the gateway page showed it to.
 */

interface ReleaseAsset {
  name: string;
  size: number;
  /** The API URL; asking it for `application/octet-stream` returns the bytes. */
  url: string;
}

interface Release {
  tag_name: string;
  name?: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

/** The Windows installer, which is what a person downloading this wants. */
const installerOf = (release: Release): ReleaseAsset | undefined =>
  release.assets.find(asset => /\.exe$/i.test(asset.name) && !/portable/i.test(asset.name))
  ?? release.assets.find(asset => /\.exe$/i.test(asset.name));

downloadRouter.get(
  '/download/desktop',
  route(async (req: Request, res: Response) => {
    if (!ALPHA_DESKTOP_REPO) {
      res.status(503).json({
        error: 'No desktop repository is configured for this deployment (ALPHA_DESKTOP_REPO).'
      });
      return;
    }

    let release: Release;
    try {
      release = await githubApi().get<Release>(`/repos/${ALPHA_DESKTOP_REPO}/releases/latest`);
    } catch (err: any) {
      // 404 here is the ordinary case before the first release, and saying so
      // is more use than "download failed".
      const detail = String(err?.message ?? err);
      res.status(err?.status === 404 ? 404 : 502).json({
        error: err?.status === 404
          ? 'No desktop release has been published yet.'
          : `Could not reach the desktop release: ${detail}`
      });
      return;
    }

    const installer = installerOf(release);
    if (!installer) {
      res.status(404).json({
        error: `Release ${release.tag_name} has no Windows installer attached.`
      });
      return;
    }

    /**
     * Streamed, not buffered. The installer is around ninety megabytes, and
     * holding that in the process to hand it over would be the largest thing
     * this service ever allocates -- on an instance with 512MB.
     */
    const upstream = await fetch(installer.url, {
      headers: {
        Authorization: `Bearer ${await tokenForThisRequest()}`,
        Accept: 'application/octet-stream',
        'User-Agent': 'Alpha'
      }
    });

    if (!upstream.ok || !upstream.body) {
      logError(`Desktop download failed: GitHub answered ${upstream.status}`);
      res.status(502).json({ error: `GitHub refused the download (${upstream.status}).` });
      return;
    }

    logInfo(`Serving ${installer.name} (${release.tag_name}) to ${req.workspace?.userId ?? 'someone'}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${installer.name}"`);
    /*
     * The length of *this* transfer, if GitHub states one -- not the size
     * recorded on the asset. They should agree, and when they do not the
     * browser waits for bytes that never come rather than finishing the
     * download.
     */
    const length = upstream.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    Readable.fromWeb(upstream.body as never).pipe(res);
  })
);

/** Which version the release is, for a page that wants to say so. */
downloadRouter.get(
  '/download/desktop/version',
  route(async (_req: Request, res: Response) => {
    if (!ALPHA_DESKTOP_REPO) {
      res.json({ version: null, available: false });
      return;
    }
    try {
      const release = await githubApi().get<Release>(`/repos/${ALPHA_DESKTOP_REPO}/releases/latest`);
      res.json({
        version: release.tag_name,
        name: release.name ?? release.tag_name,
        available: Boolean(installerOf(release))
      });
    } catch {
      res.json({ version: null, available: false });
    }
  })
);
