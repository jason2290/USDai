const { ethers } = require('ethers');
const dotenv = require('dotenv');
const fs = require('fs');
const csv = require('csv-parser');

dotenv.config();

// 配置
const RPC_URL = "https://arb1.arbitrum.io/rpc"; // Arbitrum主網RPC
const CSV_FILE = 'data.csv'; // 錢包數據CSV文件

// 隨機打亂數組的函數
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 從鏈上獲取 gasPrice (EIP-1559)
async function getGasPriceFromChain() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    try {
        const feeData = await provider.getFeeData();
        return {
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        };
    } catch (error) {
        console.error(`❌ 無法從鏈上獲取 gasPrice: ${error.message}`);
        throw error;
    }
}

// 將 USDC 數量轉換為 16 進位（6 位小數）
function usdcToHex(amount) {
    // 將 USDC 數量乘以 10^6 並轉為整數
    const amountInWei = ethers.utils.parseUnits(amount.toString(), 6);
    // 轉為 64 位 16 進位，移除 '0x' 前綴
    return amountInWei.toHexString().slice(2).padStart(64, '0');
}

// 發送交易
async function sendTransaction(walletAddress, privateKey, usdcAmount) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);

    const toAddress = "0x62dDf301B21970e7Cc12c34cAAc9CE9bC975c0a9"; // 目標合約地址
    const methodId = "0xb6b55f25"; // deposit 方法
    const amountHex = usdcToHex(usdcAmount); // 將 USDC 數量轉為 16 進位
    const calldata = methodId + amountHex;

    console.log(`執行交易: ${walletAddress} -> 合約 ${toAddress}`);
    console.log(`🟢 使用的 EVM 地址: ${wallet.address}`);
    console.log(`💰 存入 USDC 數量: ${usdcAmount}`);

    const gasFees = await getGasPriceFromChain();
    console.log(`   ⛽ Gas 參數: maxFeePerGas=${ethers.formatUnits(gasFees.maxFeePerGas, "gwei")} Gwei, maxPriorityFeePerGas=${ethers.formatUnits(gasFees.maxPriorityFeePerGas, "gwei")} Gwei`);

    const gasLimit = 210000; // 設置 gas 限制

    const tx = await wallet.sendTransaction({
        to: toAddress,
        data: calldata,
        gasLimit,
        maxFeePerGas: gasFees.maxFeePerGas,
        maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas
    });

    console.log(`   📨 交易發送成功，交易哈希: ${tx.hash}`);

    try {
        const receipt = await waitForTransactionConfirmation(tx, 30000);
        console.log(`   ✅ 交易確認，區塊號: ${receipt.blockNumber}`);
    } catch (error) {
        console.error(` ⚠️ 交易未確認: ${error.message}`);
        fs.appendFileSync('error-log.txt', `${walletAddress}: ${error.message}\n`);
    }
}

// 等待交易確認
async function waitForTransactionConfirmation(tx, timeout = 30000) {
    return Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`交易 ${tx.hash} 在 ${timeout / 1000} 秒內未確認成功`)), timeout))
    ]);
}

// 從 CSV 讀取數據並執行交易
function executeTransactionsFromCSV() {
    const results = [];
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            // 打亂錢包順序
            const shuffledWallets = shuffleArray([...results]);
            console.log(`已載入 ${shuffledWallets.length} 個錢包並隨機打亂順序`);

            for (const row of shuffledWallets) {
                const { wallet_address, private_key, usdc_amount } = row;

                try {
                    // 驗證 usdc_amount 是否有效
                    if (!usdc_amount || isNaN(usdc_amount) || Number(usdc_amount) <= 0) {
                        throw new Error(`無效的 USDC 數量: ${usdc_amount}`);
                    }
                    await sendTransaction(wallet_address, private_key, usdc_amount);
                } catch (error) {
                    console.error(`❌ 交易失敗: ${wallet_address} - ${error.message}`);
                    fs.appendFileSync('error-log.txt', `${walletAddress}: ${error.message}\n`);
                }

                // 隨機延遲 5 到 15 秒
                const delay = (Math.floor(Math.random() * 10) + 5) * 1000;
                console.log(`   ⏳ 等待 ${delay / 1000} 秒後繼續`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        });
}

// 執行交易
executeTransactionsFromCSV();