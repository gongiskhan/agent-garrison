CREATE TABLE messages_providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('system','mail','chat')),
  descriptor TEXT NOT NULL CHECK(json_valid(descriptor)), ownerNode TEXT NOT NULL,
  callbackBaseUrl TEXT, updatedAt TEXT NOT NULL
);
CREATE TABLE messages_conversations (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES messages_providers(id), account TEXT NOT NULL,
  externalId TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, participants TEXT NOT NULL DEFAULT '[]',
  lastMessageTs TEXT NOT NULL, unreadCount INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  parentConversationId TEXT, UNIQUE(provider,account,externalId)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES messages_providers(id), account TEXT NOT NULL,
  conversationId TEXT NOT NULL REFERENCES messages_conversations(id), externalId TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')), sender TEXT NOT NULL, recipients TEXT NOT NULL DEFAULT '[]',
  subject TEXT, bodyText TEXT NOT NULL, bodyMarkdown TEXT, bodyHtmlPath TEXT, attachments TEXT NOT NULL DEFAULT '[]',
  ts TEXT NOT NULL, receivedTs TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]',
  category TEXT, severity TEXT, action TEXT, cardId TEXT, conversationRef TEXT, triage TEXT, rawPath TEXT,
  suppressNotification INTEGER NOT NULL DEFAULT 0, reactions TEXT NOT NULL DEFAULT '[]', deepLink TEXT,
  ownerNode TEXT NOT NULL, htmlOwnerNode TEXT, rawOwnerNode TEXT, sourceLink TEXT, mirrorTargets TEXT, providerHash TEXT, localState TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE(provider,account,externalId)
);
CREATE INDEX messages_time ON messages(ts DESC,id DESC);
CREATE INDEX messages_conversation_time ON messages(conversationId,ts,id);
CREATE INDEX messages_inbox ON messages(deleted,archived,read,ts DESC);
CREATE VIRTUAL TABLE messages_fts USING fts5(messageId UNINDEXED, subject, bodyText, senderName, attachmentNames, transcripts, tokenize='unicode61 remove_diacritics 2', prefix='2 3 4');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(messageId,subject,bodyText,senderName,attachmentNames,transcripts)
  SELECT new.id,new.subject,new.bodyText,json_extract(new.sender,'$.name'),
    (SELECT group_concat(json_extract(value,'$.name'),' ') FROM json_each(new.attachments)),
    (SELECT group_concat(json_extract(value,'$.transcript'),' ') FROM json_each(new.attachments));
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE messageId=old.id;
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF subject,bodyText,sender,attachments ON messages BEGIN
  DELETE FROM messages_fts WHERE messageId=old.id;
  INSERT INTO messages_fts(messageId,subject,bodyText,senderName,attachmentNames,transcripts)
  SELECT new.id,new.subject,new.bodyText,json_extract(new.sender,'$.name'),
    (SELECT group_concat(json_extract(value,'$.name'),' ') FROM json_each(new.attachments)),
    (SELECT group_concat(json_extract(value,'$.transcript'),' ') FROM json_each(new.attachments));
END;
CREATE TABLE messages_ingest_lease (
  id TEXT PRIMARY KEY CHECK(id='messages_ingest_lease'), holderNode TEXT NOT NULL,
  tokenHash TEXT NOT NULL, expiresAt TEXT NOT NULL, fence INTEGER NOT NULL
);
CREATE TABLE messages_sync (
  provider TEXT NOT NULL, account TEXT NOT NULL, cursor TEXT, lastSync TEXT, error TEXT,
  requested INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider,account)
);
CREATE TABLE messages_views (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, filter TEXT NOT NULL,
  sortOrder INTEGER NOT NULL, builtIn INTEGER NOT NULL DEFAULT 0
);
INSERT INTO messages_views VALUES
 ('all','All','Inbox','{}',0,1),('agents','Agents','Bot','{"kinds":["system"]}',1,1),
 ('mail','Mail','Mail','{"kinds":["mail"]}',2,1),('chat','Chat','MessagesSquare','{"kinds":["chat"]}',3,1);
CREATE TABLE messages_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, sortOrder INTEGER NOT NULL,
  match TEXT NOT NULL, actions TEXT NOT NULL, stopProcessing INTEGER NOT NULL,
  matchedCount INTEGER NOT NULL DEFAULT 0, lastMatchedAt TEXT, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE messages_rule_runs (
  messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ruleId TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY(messageId,ruleId,revision)
);
CREATE TABLE messages_outbox (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL REFERENCES messages_providers(id), account TEXT NOT NULL,
  target TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT NOT NULL, replyToExternalId TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('user','agent')), holdUntil TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('held','sending','sent','failed','cancelled')), error TEXT,
  createdAt TEXT NOT NULL, externalId TEXT, claimToken TEXT, claimUntil TEXT, externalReceipt TEXT, ownerNode TEXT NOT NULL
);
CREATE TABLE messages_effects (
  id TEXT PRIMARY KEY, messageId TEXT REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  error TEXT, createdAt TEXT NOT NULL, claimToken TEXT, claimUntil TEXT
);
CREATE TABLE messages_mirrors (
  messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', receipt TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  claimToken TEXT, claimUntil TEXT, PRIMARY KEY(messageId,channel)
);
CREATE TABLE messages_answers (
  messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  answer TEXT NOT NULL, status TEXT NOT NULL, claimToken TEXT NOT NULL, claimUntil TEXT NOT NULL, error TEXT
);
