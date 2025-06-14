const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const moment = require('moment');

// === Logging Configuration ===
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// === Database Setup ===
const db = new sqlite3.Database('./bot.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) {
    logger.error(`Database error: ${err.message}`);
    process.exit(1);
  }
  logger.info('Connected to the SQLite database.');
});

// Initialize database tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory (
      question TEXT PRIMARY KEY,
      answer TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      usage_count INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      is_admin BOOLEAN DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// === Default Knowledge ===
const DEFAULT_KNOWLEDGE = {
  "who are you": "I am SormGPT, your helpful assistant.",
  "who is your developer": "@l9shx is my developer.",
  "hello": "Hello! How can I help you today?",
  "hi": "Hi there! What can I do for you?",
  "help": "You can ask me anything or teach me new things using:\n\n!teach question | answer",
};

// === Database Functions ===
function getAnswer(question, callback) {
  question = question.toLowerCase().trim();
  
  // Check default knowledge first
  if (DEFAULT_KNOWLEDGE[question]) {
    return callback(null, DEFAULT_KNOWLEDGE[question]);
  }
  
  // Check database
  db.get(
    "SELECT answer FROM memory WHERE question = ?",
    [question],
    (err, row) => {
      if (err) {
        logger.error(`Error fetching answer: ${err.message}`);
        return callback(err);
      }
      
      if (row) {
        // Increment usage count
        db.run(
          "UPDATE memory SET usage_count = usage_count + 1 WHERE question = ?",
          [question],
          (err) => {
            if (err) {
              logger.error(`Error updating usage count: ${err.message}`);
            }
          }
        );
        return callback(null, row.answer);
      }
      
      callback(null, null);
    }
  );
}

function saveLog(userId, username, message) {
  db.run(
    "INSERT INTO logs (user_id, username, message) VALUES (?, ?, ?)",
    [userId, username, message],
    (err) => {
      if (err) {
        logger.error(`Error saving log: ${err.message}`);
      }
    }
  );
}

function teachQuestion(question, answer, callback) {
  db.run(
    "INSERT OR REPLACE INTO memory (question, answer) VALUES (?, ?)",
    [question.toLowerCase().trim(), answer.trim()],
    (err) => {
      if (err) {
        logger.error(`Error teaching question: ${err.message}`);
        return callback(false);
      }
      callback(true);
    }
  );
}

// === Bot Setup ===
const BOT_TOKEN = '7770178544:AAHQ-z5DqXNo6ymbq68-W7_aPXE1dhXLu94'; // Replace with your actual token
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// === Command Handlers ===
function handleHelp(msg) {
  const helpText = `
🤖 <b>SormGPT Help</b> 🤖

You can interact with me in these ways:

• Ask me any question
• Teach me new things with:
  <code>!teach question | answer</code>
• View stats with:
  <code>!stats</code>

I'll do my best to help you!
`;
  bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'HTML' });
}

function handleStats(msg) {
  db.serialize(() => {
    db.get("SELECT COUNT(*) as count FROM memory", (err, memoryRow) => {
      if (err) {
        logger.error(`Error getting memory count: ${err.message}`);
        return bot.sendMessage(msg.chat.id, "❌ Could not retrieve statistics.");
      }
      
      db.get("SELECT COUNT(*) as count FROM logs", (err, logRow) => {
        if (err) {
          logger.error(`Error getting log count: ${err.message}`);
          return bot.sendMessage(msg.chat.id, "❌ Could not retrieve statistics.");
        }
        
        let statsText = `
📊 <b>Bot Statistics</b>

• Learned responses: ${memoryRow.count}
• Total interactions: ${logRow.count}

<b>Top Questions:</b>
`;
        
        db.all(
          "SELECT question, usage_count FROM memory ORDER BY usage_count DESC LIMIT 5",
          (err, topQuestions) => {
            if (err) {
              logger.error(`Error getting top questions: ${err.message}`);
              return bot.sendMessage(msg.chat.id, "❌ Could not retrieve statistics.");
            }
            
            topQuestions.forEach((q, i) => {
              statsText += `\n${i+1}. ${q.question} (used ${q.usage_count} times)`;
            });
            
            bot.sendMessage(msg.chat.id, statsText, { parse_mode: 'HTML' });
          }
        );
      });
    });
  });
}

// === Message Handler ===
function handleMessage(msg) {
  if (!msg.text) return;
  
  const message = msg.text.trim();
  const user = msg.from;
  saveLog(user.id, user.username || "Unknown", message);

  // TEACH MODE
  if (message.startsWith("!teach")) {
    try {
      const data = message.substring(6).trim();
      const [question, answer] = data.split("|").map(s => s.trim());
      
      if (!question || !answer) {
        return bot.sendMessage(msg.chat.id, "❌ Invalid format. Use: !teach question | answer");
      }
      
      if (DEFAULT_KNOWLEDGE[question.toLowerCase()]) {
        return bot.sendMessage(msg.chat.id, "This is built-in knowledge and cannot be changed.");
      }
      
      teachQuestion(question, answer, (success) => {
        if (success) {
          bot.sendMessage(msg.chat.id, `✅ Learned: '${question}' → '${answer}'`);
        } else {
          bot.sendMessage(msg.chat.id, "❌ Failed to save the knowledge. Please try again.");
        }
      });
    } catch (err) {
      logger.error(`Error in teach mode: ${err.message}`);
      bot.sendMessage(msg.chat.id, "❌ An error occurred while processing your request.");
    }
    return;
  }

  // GET ANSWER
  getAnswer(message, (err, answer) => {
    if (err) {
      return bot.sendMessage(msg.chat.id, "❌ An error occurred while processing your request.");
    }
    
    if (answer) {
      bot.sendMessage(msg.chat.id, answer);
    } else {
      bot.sendMessage(
        msg.chat.id,
        "I don't know the answer to that. You can teach me using:\n\n" +
        "<code>!teach question | answer</code>",
        { parse_mode: 'HTML' }
      );
    }
  });
}

// === Bot Event Listeners ===
bot.onText(/\/help/, handleHelp);
bot.onText(/\/stats/, handleStats);
bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    handleMessage(msg);
  }
});

// === Startup Message ===
logger.info('🤖 SormGPT is starting...');
bot.on('polling_error', (error) => {
  logger.error(`Polling error: ${error.message}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Bot shutting down...');
  db.close();
  process.exit();
});