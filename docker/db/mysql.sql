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
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id INT NOT NULL,
  client_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

INSERT INTO messages (id, conversation_id, sender_id, client_id) VALUES
  (1, 1, 2, NULL),
  (2, 1, 1, NULL),
  (3, 2, 3, NULL);
