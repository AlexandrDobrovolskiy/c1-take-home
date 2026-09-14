SET NAMES utf8mb4;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL,
  username VARCHAR(60) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL
);

CREATE TABLE conversations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_participants (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  -- unread state lives server-side: a message is unread if its id is greater
  -- than what this participant has marked read (survives reloads and devices)
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id INT NOT NULL,
  client_id VARCHAR(64) NULL,
  -- body lives with the row (single store): the send is one atomic insert, and the
  -- MySQL/Mongo split's whole dual-write failure class disappears (see docs/audit.md P2)
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- idempotency: a client retry with the same clientId must not create a second message
  -- (NULL client_id rows are exempt — MySQL allows repeated NULLs in a unique index)
  UNIQUE KEY uq_messages_conversation_client (conversation_id, client_id),
  -- per-conversation access path: history reads, last-message and count lookups.
  -- InnoDB appends the PK, so this behaves as (conversation_id, id) — id-ordered per conversation.
  KEY idx_messages_conversation (conversation_id),
  -- word search with relevance ranking (search falls back to LIKE for partial words)
  FULLTEXT KEY ft_messages_body (body)
);

-- demo password for all three users: "demo" (scrypt, salt:hash)
INSERT INTO users (id, name, email, username, password_hash) VALUES
  (1, 'Alice', 'alice@example.com', 'alice', '98571aada9cdc5ff466ceb9f05b0323e:45c0f077d8a583994691da20eca78f12d0f879d5c0037b5af16b759c4b0f0716'),
  (2, 'Bob', 'bob@example.com', 'bob', 'fd9292c2c3bc08f2b0cec27d1dce8d7c:b18f898f63dafe50bf41cbb5f51040946bcff9a568d8eb36fd373c83fd1b6f25'),
  (3, 'Carol', 'carol@example.com', 'carol', '2718100c227bff1253d0f7b7997390f3:9b57543f320600543168ebad5b80d71f2f1e78add5fd38bde8826eb4e0901a0b');

INSERT INTO conversations (id, title) VALUES
  (1, 'Support — order #1042'),
  (2, 'Design sync');

INSERT INTO conversation_participants (conversation_id, user_id) VALUES
  (1, 1), (1, 2), (2, 1), (2, 3);

INSERT INTO messages (id, conversation_id, sender_id, client_id, body) VALUES
  (1, 1, 2, NULL, 'Hi, any update on order #1042?'),
  (2, 1, 1, NULL, 'Checking now — give me a minute.'),
  (3, 2, 3, NULL, 'Notes from the design sync are in the doc.');
