const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require("worker_threads");
const path = require("path");
const axios = require("axios");
const fs = require("fs").promises;
const banner = require("./banner.js");
const AsyncLock = require("async-lock");
const lock = new AsyncLock();
const config = require("./config.js");
const ethers = require("ethers"); // Add ethers import

const API_BASE_URL = "https://api.fireverseai.com";
const WEB3_URL = "https://web3.fireverseai.com";

// Add this function near the top with other imports
const sendTelegramNotification = async (message) => {
  try {
    const telegramUrl = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    await axios.post(telegramUrl, {
      chat_id: config.telegramChatId,
      text: message,
      parse_mode: "HTML",
    });
    return true;
  } catch (error) {
    console.error("Failed to send Telegram notification:", error.message);
    return false;
  }
};

// Add login with private key functionality
async function loginWithPrivateKey(privateKey) {
  try {
    const wallet = new ethers.Wallet(privateKey);
    const axiosInstance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.8",
        "content-type": "application/json",
        origin: "https://app.fireverseai.com",
        referer: "https://app.fireverseai.com/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "x-version": "1.0.100",
      },
    });

    // Get nonce
    const nonceResponse = await axiosInstance.get("/walletConnect/nonce");
    const nonce = nonceResponse.data.data.nonce;

    // Sign message
    const messageToSign = `web3.fireverseai.com wants you to sign in with your Ethereum account:\n${
      wallet.address
    }\n\nPlease sign with your account\n\nURI: https://web3.fireverseai.com\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
    const signature = await wallet.signMessage(messageToSign);

    // Verify wallet
    const verifyResponse = await axiosInstance.post("/walletConnect/verify", {
      message: messageToSign,
      signature: signature,
      wallet: "bee",
    });

    if (verifyResponse.data?.success) {
      return verifyResponse.data.data.token;
    }
    throw new Error("Verification failed");
  } catch (error) {
    console.error("Login error:", error.message);
    throw error;
  }
}

// Modify the global state
const globalState = {
  logBuffer: new Map(),
  lastUpdate: Date.now(),
  updateInterval: 10000, // Reduce to 1 second for smoother updates
  isUpdating: false,
};

// Move the FireverseMusicBot class definition before any usage
class FireverseMusicBot {
  constructor(token, accountIndex, accountName, privateKey = null) {
    this.baseUrl = "https://api.fireverseai.com";
    this.token = token;
    this.accountIndex = accountIndex;
    this.accountName = accountName;
    this.playedSongs = new Set();
    this.dailyPlayCount = 0;
    this.DAILY_LIMIT = 50;
    this.lastHeartbeat = Date.now();
    this.totalListeningTime = 0;
    this.headers = {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.8",
      "content-type": "application/json",
      origin: "https://app.fireverseai.com",
      referer: "https://app.fireverseai.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      "x-version": "1.0.100",
      "sec-ch-ua": '"Not(A:Brand";v="99", "Brave";v="133", "Chromium";v="133"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      token: token,
    };
    this.lock = new AsyncLock();
    this.lastLogTime = Date.now();
    this.logDelay = 3000; // Increase delay to 3 seconds
    this.lastMessage = ""; // Track last message for in-place updates
    this.logBuffer = []; // Add buffer for logs
    this.currentLevel = 0;
    this.currentScore = 0;
    this.updateInterval = 3000;
    this.privateKey = privateKey; // Add this line
  }

  async log(message, inPlace = false) {
    const prefix = `[${this.accountName}] `;
    const fullMessage = `${prefix}${message}`;

    if (inPlace) {
      // Update global state
      globalState.logBuffer.set(this.accountName, fullMessage);

      // Any worker can trigger the update if enough time has passed
      const now = Date.now();
      if (
        !globalState.isUpdating &&
        now - globalState.lastUpdate >= globalState.updateInterval
      ) {
        globalState.isUpdating = true;
        await this.lock.acquire("console", () => {
          try {
            console.clear();
            const sortedMessages = Array.from(
              globalState.logBuffer.entries()
            ).sort(([nameA], [nameB]) => {
              // Extract numbers from account names for proper sorting
              const numA = parseInt(nameA.match(/\d+/)[0]);
              const numB = parseInt(nameB.match(/\d+/)[0]);
              return numA - numB;
            });

            sortedMessages.forEach(([_, msg]) => {
              console.log(msg);
            });
          } finally {
            globalState.lastUpdate = now;
            globalState.isUpdating = false;
          }
        });
      }
    } else {
      // For important messages, show them above the progress
      await this.lock.acquire("console", () => {
        console.clear();
        console.log(fullMessage);
        // Redraw all progress messages
        const sortedMessages = Array.from(globalState.logBuffer.entries()).sort(
          ([nameA], [nameB]) => {
            const numA = parseInt(nameA.match(/\d+/)[0]);
            const numB = parseInt(nameB.match(/\d+/)[0]);
            return numA - numB;
          }
        );
        sortedMessages.forEach(([_, msg]) => {
          console.log(msg);
        });
      });
    }
  }

  async clearLine() {
    await this.lock.acquire("console", () => {
      console.clear(); // Clear console instead of using clearLine
    });
  }

  formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  async initialize() {
    try {
      await this.getUserInfo();
      await this.getDailyTasks();
      return true;
    } catch (error) {
      this.log("❌ Error initializing bot: " + error.message);
      return false;
    }
  }

  async getUserInfo() {
    try {
      const response = await axios.get(`${this.baseUrl}/userInfo/getMyInfo`, {
        headers: this.headers,
      });
      const { level, expValue, score, nextLevelExpValue } = response.data.data;
      this.currentLevel = level;
      this.currentScore = score;

      // Check if level & score meet requirements using class properties
      if (this.currentLevel >= 5 && this.currentScore >= 2000) {
        this.log(
          "\n🎯 Level 5+ and Score 2000+ detected! Initiating points transfer..."
        );
        await this.sendPoints();
      }

      this.log("\n📊 User Stats:");
      this.log(
        `Level: ${this.currentLevel} | EXP: ${expValue}/${nextLevelExpValue} | Score: ${this.currentScore}`
      );
      this.log(
        `Total Listening Time: ${Math.floor(
          this.totalListeningTime / 60
        )} minutes\n`
      );
    } catch (error) {
      this.log("❌ Error getting user info: " + error.message);
    }
  }

  calculateFee(amount) {
    return Math.floor(amount / 10);
  }

  computeMaxSendAmount(balance) {
    let low = 0;
    let high = balance;
    let result = 0;
    while (low <= high) {
      let mid = Math.floor((low + high) / 2);
      if (mid + Math.floor(mid / 10) <= balance) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  }

  async followUser(userId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/musicUserFollow/follow`,
        { followUserId: userId },
        { headers: this.headers }
      );

      if (response.data?.success) {
        this.log(`✅ Successfully followed user: ${userId}`);
        return true;
      }
      return false;
    } catch (error) {
      this.log(`❌ Error following user ${userId}: ${error.message}`);
      return false;
    }
  }

  async sendPoints() {
    try {
      if (!config.targetUserIds || config.targetUserIds.length === 0) {
        this.log("\n❌ Error: targetUserIds not configured in config.js");
        return false;
      }

      this.log(`\n📊 Current Stats Before Transfer:`);
      this.log(`Level: ${this.currentLevel}`);
      this.log(`Score: ${this.currentScore}`);

      if (this.currentLevel >= 5 && this.currentScore >= 2000) {
        // Calculate points per target
        const targetCount = config.targetUserIds.length;
        const maxSendAmount = this.computeMaxSendAmount(this.currentScore);
        const pointsPerTarget = Math.floor(maxSendAmount / targetCount);

        let totalSent = 0;
        let overallSuccess = false;

        for (const targetId of config.targetUserIds) {
          let sendScores = pointsPerTarget;
          const maxRetries = 5;
          let attempt = 0;
          let success = false;

          // Follow target user first
          await this.followUser(targetId);

          while (attempt < maxRetries && sendScores > 0) {
            const fee = this.calculateFee(sendScores);
            const totalDeduction = sendScores + fee;

            this.log(
              `\n💰 Attempt ${
                attempt + 1
              }: Sending ${sendScores} points to ${targetId}`
            );
            this.log(`📊 Fee: ${fee}, Total deduction: ${totalDeduction}`);

            try {
              const response = await axios.post(
                `${this.baseUrl}/musicUserScore/sendPoints`,
                {
                  sendScore: sendScores,
                  sendUserId: targetId,
                },
                { headers: this.headers }
              );

              if (response.data?.success) {
                success = true;
                overallSuccess = true;
                totalSent += sendScores;

                const notificationMessage = `
<b>🎯 Points Transfer Successful</b>
Account: ${this.accountName}
Target: ${targetId}
Amount: ${sendScores}
Fee: ${fee}
Total Deducted: ${totalDeduction}
Time: ${new Date().toLocaleString()}`;

                await sendTelegramNotification(notificationMessage);
                this.log(
                  `\n✅ Successfully sent ${sendScores} points to ${targetId}`
                );

                // Update current score after transfer
                this.currentScore -= totalDeduction;
                break;
              }
            } catch (error) {
              this.log(`\n⚠️ Attempt ${attempt + 1} failed: ${error.message}`);
            }

            // Reduce amount for next attempt
            sendScores = Math.floor(sendScores * 0.9);
            attempt++;
          }

          if (!success) {
            this.log(
              `\n❌ Failed to send points to ${targetId} after ${maxRetries} attempts`
            );
          }
        }

        this.log(`\n📊 Transfer Summary:`);
        this.log(`Total points sent: ${totalSent}`);
        this.log(`Remaining score: ${this.currentScore}`);

        return overallSuccess;
      } else {
        this.log("\n⚠️ Transfer conditions not met - skipping transfer");
        return false;
      }
    } catch (error) {
      this.log("\n❌ Error sending points: " + error.message);
      if (error.response) {
        this.log(`Response data: ${JSON.stringify(error.response.data)}`);
      }
      return false;
    }
  }

  async getDailyTasks() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/musicTask/getListByCategory?taskCategory=1`,
        { headers: this.headers }
      );

      if (response.data?.data && Array.isArray(response.data.data)) {
        this.log("\n📋 Daily Tasks:");
        response.data.data.forEach((task) => {
          if (task && task.name) {
            let progress;
            if (task.taskKey === "play_music" && task.unit === "minutes") {
              progress = `${Math.floor(this.totalListeningTime / 60)}/${
                task.completeNum
              }`;
            } else {
              progress =
                task.itemCount ||
                `${task.completedRounds || 0}/${
                  task.maxCompleteLimit || task.completeNum || 0
                }`;
            }
            this.log(
              `- ${task.name}: ${progress} (${task.rewardScore} points)`
            );
          }
        });
        this.log("");
      }
    } catch (error) {
      this.log("❌ Error getting daily tasks: " + error.message);
    }
  }

  async getRecommendedSongs() {
    try {
      const response = await axios.post(
        `${this.baseUrl}/home/getRecommend`,
        { type: 1 },
        { headers: this.headers }
      );
      return response.data?.data || [];
    } catch (error) {
      this.log("❌ Error getting recommended songs: " + error.message);
      return [];
    }
  }

  async addToHistory(musicId) {
    try {
      await axios.post(
        `${this.baseUrl}/musicHistory/addToHistory/${musicId}`,
        {},
        { headers: this.headers }
      );
    } catch (error) {
      this.log("❌ Error adding to history: " + error.message);
    }
  }

  async getMusicDetails(musicId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/music/getDetailById?musicId=${musicId}`,
        { headers: this.headers }
      );
      return response.data?.data;
    } catch (error) {
      this.log("❌ Error getting music details: " + error.message);
      return null;
    }
  }

  async sendHeartbeat() {
    try {
      const now = Date.now();
      if (now - this.lastHeartbeat >= 30000) {
        await axios.post(
          `${this.baseUrl}/music/userOnlineTime/receiveHeartbeat`,
          {},
          { headers: this.headers }
        );
        this.lastHeartbeat = now;
        await this.log("💓", true);
      }
    } catch (error) {
      // Silent heartbeat errors
    }
  }

  async playMusic(musicId) {
    try {
      await axios.post(
        `${this.baseUrl}/musicUserBehavior/playEvent`,
        { musicId, event: "playing" },
        { headers: this.headers }
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async endMusic(musicId) {
    try {
      await axios.post(
        `${this.baseUrl}/musicUserBehavior/playEvent`,
        { musicId, event: "playEnd" },
        { headers: this.headers }
      );
      return true;
    } catch (error) {
      this.log("❌ Error ending music: " + error.message);
      return false;
    }
  }

  async likeMusic(musicId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/musicMyFavorite/addToMyFavorite?musicId=${musicId}`,
        {},
        { headers: this.headers }
      );
      return response.data?.success || false;
    } catch (error) {
      this.log("❌ Error liking music: " + error.message);
      return false;
    }
  }

  async commentMusic(musicId, content = "good one") {
    try {
      const commentData = {
        content,
        musicId,
        parentId: 0,
        rootId: 0,
      };

      const response = await axios.post(
        `${this.baseUrl}/musicComment/addComment`,
        commentData,
        { headers: this.headers }
      );
      return response.data?.success || false;
    } catch (error) {
      this.log("❌ Error commenting on music: " + error.message);
      return false;
    }
  }

  // Modify the playSession method to check score conditions after each song
  async playSession() {
    try {
      if (this.dailyPlayCount >= this.DAILY_LIMIT) {
        this.log(
          `\n🎵 Daily limit reached (${this.DAILY_LIMIT}/${this.DAILY_LIMIT}). Waiting for reset...`
        );
        return false;
      }

      const songs = await this.getRecommendedSongs();
      if (!songs || songs.length === 0) {
        this.log("\n❌ No songs available, retrying in 5 seconds...");
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return true;
      }

      for (const song of songs) {
        if (this.playedSongs.has(song.id)) continue;

        this.playedSongs.add(song.id);
        this.dailyPlayCount++;

        const musicDetails = (await this.getMusicDetails(song.id)) || {};
        const duration = musicDetails.duration || song.duration || 180;

        await this.addToHistory(song.id);

        const songName =
          song.musicName || musicDetails.musicName || "Unknown Song";
        const author = song.author || musicDetails.author || "Unknown Artist";

        this.log("\n▶️  Now Playing:");
        this.log(`🎵 Title: ${songName}`);
        this.log(`👤 Artist: ${author}`);
        this.log(`🆔 Music ID: ${song.id}`);
        this.log(
          `📊 Progress: ${this.dailyPlayCount}/${this.DAILY_LIMIT} songs today`
        );
        this.log(`⏱️  Duration: ${this.formatTime(duration)}`);

        const likeSuccess = await this.likeMusic(song.id);
        this.log(
          `${likeSuccess ? "❤️" : "💔"} Like status: ${
            likeSuccess ? "Success" : "Failed"
          }`
        );

        const commentSuccess = await this.commentMusic(song.id);
        this.log(`💬 Comment status: ${commentSuccess ? "Success" : "Failed"}`);

        if (await this.playMusic(song.id)) {
          let secondsPlayed = 0;

          for (let timeLeft = duration; timeLeft > 0; timeLeft--) {
            await this.sendHeartbeat();
            secondsPlayed++;
            this.totalListeningTime++;

            // Update every second instead of every 3 seconds
            await this.log(
              `⏳ Time remaining: ${this.formatTime(timeLeft)} | ` +
                `Lv.${this.currentLevel} | ` +
                `💰 ${this.currentScore} | ` +
                `Listening time: ${Math.floor(
                  this.totalListeningTime / 60
                )} minutes`,
              true
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          const endSuccess = await this.endMusic(song.id);

          if (endSuccess) {
            this.log("\n✅ Finished playing");

            // Get updated user info and check conditions
            await this.getUserInfo();
            this.log(
              `\n🔍 Checking transfer conditions: Level ${this.currentLevel} (≥5), Score ${this.currentScore} (≥2000)`
            );

            if (this.currentLevel >= 5 && this.currentScore >= 2000) {
              this.log(
                "\n🎯 Transfer conditions met! Initiating points transfer..."
              );
              const transferSuccess = await this.sendPoints();
              if (transferSuccess) {
                this.log("✨ Transfer completed successfully");
                // Get updated info after transfer
                await this.getUserInfo();
              }
            }

            await this.getDailyTasks();
          } else {
            this.log("\n⚠️ Song ended but playEnd event failed");
          }
          break;
        } else {
          this.log("\n❌ Failed to play song");
        }
      }

      return true;
    } catch (error) {
      this.log("❌ Error in play session: " + error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return true;
    }
  }

  // Add token refresh method
  async refreshToken() {
    try {
      if (!this.privateKey) {
        this.log("❌ No private key available for token refresh");
        return false;
      }

      this.log("🔄 Refreshing token...");
      const newToken = await loginWithPrivateKey(this.privateKey);
      if (newToken) {
        this.token = newToken;
        this.headers.token = newToken;
        this.log("✅ Token refreshed successfully");
        return true;
      }
      throw new Error("Failed to get new token");
    } catch (error) {
      this.log(`❌ Token refresh failed: ${error.message}`);
      return false;
    }
  }

  // Modify startDailyLoop to include token refresh
  async startDailyLoop() {
    while (true) {
      const shouldContinue = await this.playSession();

      if (!shouldContinue) {
        this.log("\n⏰ Waiting 24 hours before next session...");
        for (let timeLeft = 24 * 60 * 60; timeLeft > 0; timeLeft--) {
          if (timeLeft % 5 === 0) {
            await this.log(
              `⏳ Next session in: ${this.formatTime(timeLeft)}`,
              true
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Refresh token before starting new session
        if (this.privateKey) {
          const refreshSuccess = await this.refreshToken();
          if (!refreshSuccess) {
            this.log("⚠️ Token refresh failed, continuing with existing token");
          }
        }

        this.dailyPlayCount = 0;
        this.playedSongs.clear();
        this.totalListeningTime = 0;
        this.log("\n🔄 Starting new daily session");
        await this.getUserInfo();
        await this.getDailyTasks();
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
}

// Only show banner in main thread
if (isMainThread) {
  console.log(banner);
}

// Worker thread code
if (!isMainThread) {
  const { token, accountIndex, accountName, privateKey } = workerData;
  const bot = new FireverseMusicBot(
    token,
    accountIndex,
    accountName,
    privateKey
  );

  bot
    .initialize()
    .then((success) => {
      if (success) {
        return bot.startDailyLoop();
      }
    })
    .catch((error) => {
      console.error(`[Account ${accountIndex}] ❌ Worker error:`, error);
    });
}

// Modify readTokens to handle private keys
async function readTokens() {
  try {
    const content = await fs.readFile("pk.txt", "utf-8");
    const lines = content
      .split("\n")
      .map((line) => line?.trim())
      .filter((line) => line && line.length > 0 && !line.startsWith("#"));

    const tokens = [];
    for (const line of lines) {
      try {
        // Attempt to login with the private key directly
        const token = await loginWithPrivateKey(line);
        tokens.push({
          name: `Wallet-${tokens.length + 1}`,
          token,
          privateKey: line,
        });
        console.log(`✅ Logged in successfully with wallet ${tokens.length}`);
      } catch (error) {
        console.error(
          `❌ Failed to login with private key: ${line.slice(0, 10)}...`
        );
      }
    }

    if (tokens.length === 0) {
      throw new Error("No valid tokens found in pk.txt");
    }

    console.log(`📱 Found ${tokens.length} valid tokens`);
    return tokens;
  } catch (error) {
    if (error.code === "ENOENT") {
      console.error("❌ Error: pk.txt file not found");
    } else {
      console.error("❌ Error reading tokens:", error.message);
    }
    process.exit(1);
  }
}

// Modified main function to use workers
async function main() {
  try {
    const tokens = await readTokens();

    if (tokens.length === 0) {
      console.error("❌ No tokens found in tokens.txt");
      process.exit(1);
    }

    console.log(`📱 Found ${tokens.length} account(s)`);
    console.log("🚀 Starting worker threads...\n");

    // Clear global state
    globalState.logBuffer.clear();

    // Initialize global log buffer
    global.logBuffer = new Array(tokens.length).fill("");

    const workers = tokens.map((tokenInfo, index) => {
      const worker = new Worker(__filename, {
        workerData: {
          token: tokenInfo.token,
          accountIndex: index + 1,
          accountName: tokenInfo.name,
          privateKey: tokenInfo.privateKey,
        },
      });

      // Handle worker messages
      worker.on("error", (error) => {
        console.error(`[${tokenInfo.name}] ❌ Worker error:`, error);
      });

      worker.on("exit", (code) => {
        if (code !== 0) {
          console.error(
            `[${tokenInfo.name}] ❌ Worker stopped with exit code ${code}`
          );
        }
      });

      return worker;
    });

    // Wait for all workers to finish (they won't in this case, but good practice)
    await Promise.all(
      workers.map((worker) => {
        return new Promise((resolve) => {
          worker.on("exit", resolve);
        });
      })
    );
  } catch (error) {
    console.error("❌ Fatal error:", error);
    process.exit(1);
  }
}

// Only run main in the main thread
if (isMainThread) {
  main().catch(console.error);
}
