/**
 * Bootstrap: load the environment, build the app, connect to MongoDB, listen,
 * and handle the signal that ends it.
 *
 * The app itself — middleware, session config and every route mount — lives in
 * `app.js` so that tests can construct it without a database. Keep this file to
 * process concerns only.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

import { createApp } from './app.js';
import { closeAllStreams } from './lib/broadcaster.js';
import { createShutdown } from './lib/shutdown.js';

const PORT = process.env.API_PORT ?? 3001;
const app = createApp();

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    const server = app.listen(PORT, () => console.log(`API listening on port ${PORT}`));

    // A host sends SIGTERM at every deploy; without this the process dies
    // mid-request and every live stream dies at the socket. See lib/shutdown.js
    // for the stages and why the sequence always ends in an explicit exit.
    const shutdown = createShutdown({
      server,
      closeStreams: closeAllStreams,
      disconnect: () => mongoose.disconnect(),
    });

    // The handler is idempotent, so a host (or an impatient Ctrl-C) sending a
    // second signal joins the running shutdown instead of starting another.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        shutdown(signal).catch((err) => console.error('[shutdown] sequence failed:', err));
      });
    }
  })
  .catch((err) => {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });
