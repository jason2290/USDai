const { ethers } = require('ethers');
const dotenv = require('dotenv');
const fs = require('fs');
const csv = require('csv-parser');
const PQueue = require('p-queue');

dotenv.config();

// 配置
const RPC_URL = "https://eth.drpc.org"; // Arbitrum主網RPC
const CSV_FILE = 'data.csv'; // 錢包數據CSV文件
const CONCURRENCY_LIMIT = 20; // 最大並行數量（線程數）

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

// 發送交易並返回交易對象
async function sendTransaction(walletAddress, privateKey) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);

    const toAddress = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // 目標合約地址
    const calldata =
        "0x095ea7b3" +
        "0000000000000000000000006503de9fe77d256d9d823f2d335ce83ece9e153f" +
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    console.log(`執行交易: ${walletAddress} -> 合約 ${toAddress}`);
    console.log(`🟢 使用的 EVM 地址: ${wallet.address}`);
    console.log(`📜 Calldata: ${calldata}`);

    const gasFees = await getGasPriceFromChain();
    console.log(
        `   ⛽ Gas 參數: maxFeePerGas=${ethers.utils.formatUnits(
            gasFees.maxFeePerGas,
            "gwei"
        )} Gwei, maxPriorityFeePerGas=${ethers.utils.formatUnits(
            gasFees.maxPriorityFeePerGas,
            "gwei"
        )} Gwei`
    );

    // 估算 gas 限制
    const estimatedGas = await provider.estimateGas({
        from: wallet.address,
        to: toAddress,
        data: calldata,
    });
    const gasLimit = estimatedGas.mul(120).div(100); // 增加 20% 緩衝

    const tx = await wallet.sendTransaction({
        to: toAddress,
        data: calldata,
        gasLimit,
        maxFeePerGas: gasFees.maxFeePerGas,
        maxPriorityFeePerGas: gasFees.maxPriorityFeePerGas,
    });

    console.log(`   📨 交易發送成功，交易哈希: ${tx.hash}`);
    return tx; // 返回交易對象以供後續確認
}

// 等待交易確認
async function waitForTransactionConfirmation(tx, walletAddress, timeout = 30000) {
    try {
        const receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`交易 ${tx.hash} 在 ${timeout / 1000} 秒內未確認成功`)),
                    timeout
                )
            ),
        ]);
        console.log(`   ✅ 交易確認，區塊號: ${receipt.blockNumber}`);
    } catch (error) {
        console.error(`   ❌ 交易確認失敗: ${tx.hash} - ${error.message}`);
        fs.appendFileSync('error-log.txt', `${walletAddress}: 交易確認失敗 - ${error.message}\n`);
    }
}

// 從 CSV 讀取數據並執行交易
async function executeTransactionsFromCSV() {
    const results = [];
    fs.createReadStream(CSV_FILE)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            // 打亂錢包順序
            const shuffledWallets = shuffleArray([...results]);
            console.log(`已載入 ${shuffledWallets.length} 個錢包並隨機打亂順序`);

            // 創建併發隊列
            const queue = new PQueue({ concurrency: CONCURRENCY_LIMIT });

            // 存儲所有交易的確認任務
            const confirmationPromises = [];

            for (const row of shuffledWallets) {
                const { wallet_address, private_key } = row;

                // 將交易任務添加到隊列
                queue.add(async () => {
                    try {
                        // 驗證地址
                        if (!ethers.utils.isAddress(wallet_address)) {
                            throw new Error(`無效的錢包地址: ${wallet_address}`);
                        }

                        // 發送交易
                        const tx = await sendTransaction(wallet_address, private_key);

                        // 將確認任務添加到確認列表（不等待）
                        confirmationPromises.push(waitForTransactionConfirmation(tx, wallet_address));
                    } catch (error) {
                        console.error(`❌ 交易失敗: ${wallet_address} - ${error.message}`);
                        fs.appendFileSync('error-log.txt', `${wallet_address}: ${error.message}\n`);
                    }
                });
            }

            // 等待所有交易發送完成
            await queue.onIdle();
            console.log('所有交易已發送！開始確認交易...');

            // 等待所有交易確認
            await Promise.all(confirmationPromises);
            console.log('所有交易確認完成！');
        });
}

// 執行交易
executeTransactionsFromCSV().catch((error) => {
    console.error(`❌ 執行交易時發生錯誤: ${error.message}`);
    fs.appendFileSync('error-log.txt', `全局錯誤: ${error.message}\n`);
});