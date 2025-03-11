const axios = require('axios');
const fs = require('fs');

const API_BASE_URL = 'https://api.fireverseai.com';
const TARGET_USER_ID = process.argv[2];
let totalPointsSent = 0; // Add this line to track total points

if (!TARGET_USER_ID) {
  console.error('Usage: node script.js <targetUserId>');
  process.exit(1);
}

// Fungsi untuk membaca token dari semua file .txt
function readTokens() {
  try {
    const tokenSet = new Set(); // Use Set to avoid duplicates
    const files = fs.readdirSync('.').filter(file => file.endsWith('.txt'));
    
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const tokenRegex = /eyJhbGciOiJIUzI1NiJ9[^\n]+/g;
      const matches = content.match(tokenRegex) || [];
      matches.forEach(token => tokenSet.add(token.trim()));
    }

    const tokens = Array.from(tokenSet);
    
    if (tokens.length === 0) {
      console.error('❌ No valid tokens found in any .txt file');
      process.exit(1);
    }

    console.log(`📝 Found ${tokens.length} unique tokens from ${files.length} text files`);
    return tokens;

  } catch (error) {
    console.error('❌ Error reading token files:', error.message);
    process.exit(1);
  }
}

// Membuat instance Axios dengan token tertentu
function createAxiosInstance(token) {
  return axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'accept': '*/*',
      'token': token,
      'x-version': '1.0.100',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
    }
  });
}

// Mendapatkan saldo dari API
async function getMyBalance(api) {
  try {
    const response = await api.get('/userInfo/getMyInfo');
    return response.data.data.score;
  } catch (error) {
    console.error('❌ Error getting balance:', error.message);
    throw error;
  }
}

// Memeriksa apakah target user ID ada
async function checkUserExists(api, userId) {
  try {
    const response = await api.get(`/userInfo/getByUserId?userId=${userId}`);
    return response.data.success;
  } catch (error) {
    return false;
  }
}

// Menghitung fee (10% dari jumlah yang dikirim, dengan pembulatan ke bawah)
function calculateFee(amount) {
  return Math.floor(amount / 10);
}

// Menghitung jumlah maksimum yang dapat dikirim sehingga: sendAmount + fee <= balance
function computeMaxSendAmount(balance) {
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

// Mengirim poin ke target user
async function sendPoints(api, userId, amount) {
  try {
    const response = await api.post('/musicUserScore/sendPoints', {
      sendScore: amount,
      sendUserId: parseInt(userId)
    });
    return response.data.success;
  } catch (error) {
    console.error('❌ Error sending points:', error.message);
    throw error;
  }
}

// Memproses transaksi untuk satu token
async function processToken(api, tokenIndex) {
  try {
    const balance = await getMyBalance(api);
    console.log(`💰 Token ${tokenIndex + 1} | Balance: ${balance} poin`);
    
    let sendAmount = computeMaxSendAmount(balance);
    if (sendAmount <= 0) {
      console.log(`⚠️ Token ${tokenIndex + 1} | Saldo tidak cukup untuk transaksi.`);
      return;
    }
    
    let fee = calculateFee(sendAmount);
    let totalDeduction = sendAmount + fee;
    console.log(`📜 Token ${tokenIndex + 1} | Akan mengirim ${sendAmount} poin (Fee: ${fee}, Total Deduksi: ${totalDeduction})`);
    
    // Jika transaksi gagal, coba kurangi nilai pengiriman secara bertahap
    const maxRetries = 10;
    let attempt = 0;
    let success = false;
    
    while (attempt < maxRetries && sendAmount > 0) {
      try {
        success = await sendPoints(api, TARGET_USER_ID, sendAmount);
        if (success) {
          totalPointsSent += sendAmount; // Add successful transfer to total
          break;
        }
      } catch (err) {
        // Gagal, lanjutkan ke percobaan selanjutnya
      }
      sendAmount--; // Kurangi jumlah pengiriman 1 poin
      fee = calculateFee(sendAmount);
      totalDeduction = sendAmount + fee;
      console.log(`🔄 Token ${tokenIndex + 1} | Mencoba mengirim ${sendAmount} poin (Fee: ${fee}, Total Deduksi: ${totalDeduction})`);
      attempt++;
    }
    
    if (success) {
      console.log(`✅ Token ${tokenIndex + 1} | Transaksi berhasil!`);
      const newBalance = await getMyBalance(api);
      console.log(`💰 Saldo baru: ${newBalance} poin\n`);
    } else {
      console.log(`❌ Token ${tokenIndex + 1} | Transaksi gagal setelah ${maxRetries} percobaan!\n`);
    }
    
  } catch (error) {
    console.error(`❌ Token ${tokenIndex + 1} | Error: ${error.message}\n`);
  }
}

// Memproses semua token yang ada di tokentuyul.txt
async function processAllTokens() {
  const tokens = readTokens();
  if (tokens.length === 0) {
    console.error('❌ Tidak ada token ditemukan di tokentuyul.txt');
    process.exit(1);
  }
  
  // Cek keberadaan target user ID menggunakan token pertama
  const testApi = createAxiosInstance(tokens[0]);
  const userExists = await checkUserExists(testApi, TARGET_USER_ID);
  if (!userExists) {
    console.error('❌ Target user ID tidak ditemukan!');
    process.exit(1);
  }
  
  // Proses tiap token secara berurutan
  for (let i = 0; i < tokens.length; i++) {
    const api = createAxiosInstance(tokens[i]);
    await processToken(api, i);
  }
  
  console.log('🚀 Semua token telah diproses.');
  console.log(`📊 Total poin berhasil dikirim: ${totalPointsSent}`);
}

// Mulai proses
processAllTokens();

