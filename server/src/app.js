/**
 * Express application factory.
 *
 * Everything the API is — middleware, session handling and route mounts — lives
 * here; `index.js` is only the bootstrap that connects to MongoDB and listens.
 * Splitting them lets tests build a real app and drive it over HTTP without a
 * database: pass a `sessionStore` (an `express-session` MemoryStore, say) and
 * nothing here reaches for Mongo at construction time.
 *
 * Mount order is load-bearing and must stay as it is — see the comments below.
 */

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import MongoStore from 'connect-mongo';

import entitiesRouter from './routes/entities.js';
import draftsRouter from './routes/drafts.js';
import tagsRouter from './routes/tags.js';
import openQuestionsRouter from './routes/openQuestions.js';
import relationshipTypesRouter from './routes/relationshipTypes.js';
import entityTypesRouter from './routes/entityTypes.js';
import authRouter from './routes/auth.js';
import mcpRouter from './routes/mcp.js';
import oauthRouter from './routes/oauth.js';
import eventsRouter from './routes/events.js';
import changelogRouter from './routes/changelog.js';
import relationshipGroupsRouter from './routes/relationshipGroups.js';
import chatRouter from './routes/chat.js';
import conversationsRouter from './routes/conversations.js';
import './models/User.js';
import './models/Conversation.js';
import './models/OpenQuestion.js'; // ensure model is registered for population
import './models/RelationshipType.js';
import './models/EntityType.js';
import './models/RelationshipGroup.js';
import { requireAuth } from './middleware/auth.js';
import { resolveWorkspace } from './middleware/workspace.js';

/**
 * @param {object}  [options]
 * @param {object}  [options.sessionStore] express-session store. Defaults to the
 *   MongoStore the deployed app uses; supplied by tests to stay off the database.
 * @returns {import('express').Express}
 */
export function createApp({ sessionStore } = {}) {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  app.set('trust proxy', 1); // trust Railway's reverse proxy so secure cookies work

  app.use(cors({
    origin: process.env.CLIENT_ORIGIN,
    credentials: true,
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // `??` short-circuits, so the Mongo-backed store is never constructed when
    // a caller supplied its own.
    store: sessionStore ?? MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      domain: isProd ? '.kol-emet.danielecker.dev' : undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));

  app.use('/', oauthRouter);
  app.use('/auth', authRouter);
  app.use('/mcp', mcpRouter);
  // resolveWorkspace here too: the SSE stream pushes full entity documents, so
  // each connection must be tagged with a workspace to filter broadcasts by.
  app.use('/events', requireAuth, resolveWorkspace, eventsRouter);
  // resolveWorkspace sits behind requireAuth on every route that touches tenant
  // content: it sets req.workspaceId, which those routes filter every query on.
  app.use('/entities', requireAuth, resolveWorkspace, entitiesRouter);
  app.use('/', requireAuth, resolveWorkspace, changelogRouter);
  app.use('/relationship-groups', requireAuth, resolveWorkspace, relationshipGroupsRouter);
  app.use('/tags', requireAuth, resolveWorkspace, tagsRouter);
  app.use('/open-questions', requireAuth, resolveWorkspace, openQuestionsRouter);
  app.use('/relationship-types', requireAuth, resolveWorkspace, relationshipTypesRouter);
  app.use('/entity-types', requireAuth, resolveWorkspace, entityTypesRouter);
  // Chat authenticates per-route rather than at mount, so it resolves the
  // workspace per-route too — see routes/chat.js.
  app.use('/chat', chatRouter);
  app.use('/conversations', requireAuth, resolveWorkspace, conversationsRouter);
  app.use('/drafts', requireAuth, resolveWorkspace, draftsRouter);

  return app;
}

export default createApp;
