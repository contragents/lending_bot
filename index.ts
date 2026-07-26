import { CONFIG, LENDING, POOLS, type WalletBalances } from './config.js'; // Важно: в ESM нужно указывать .js
import { ethers } from 'ethers';


import { estimatePriceImpact, sleep } from './utils/utils.js';
import { getJumperQuote, get0xQuoteV2, getUniswapPoolPrice, getWalletBalances } from './utils/utils.js';
import { provider } from "./config.js";
import { repayMoonwellAsset } from "./utils/moonwell/repayAsset.js";
import { borrowMoonwellAsset } from "./utils/moonwell/borrowAsset.js";
import { getMoonwellPositions } from "./utils/moonwell/getMoonwellPositions.js";
import { getMoonwellData } from "./utils/moonwell/getMoonwellData.js";
import { supplyMoonwellAsset } from "./utils/moonwell/supplyMoonwellAsset.js";
import { wallet } from "./utils/loadWallet.js";
import { withdrawMoonwellAsset } from "./utils/moonwell/withdrawMoonwellAsset.js";
import { swapToEth } from "./utils/uniswap/swap.js";


async function main() {


	await getMoonwellData(); // Общий статус
	//await getMoonwellPositions(); // Детальный список позиций


	// Получаем слепок всех балансов на кошельке
	let walletBalances = await getWalletBalances() as WalletBalances;
	console.log(walletBalances);
	//await getJumperQuote();
	//await get0xQuoteV2("1.0");
	await getMoonwellPositions(); // Детальный список позиций + корректировкаQ

	if (CONFIG.CHAIN === 'OPT') {
		const borrowAmount = 100;
		const supplyAmount = 0.01;

		if (wallet) {
			walletBalances = await getWalletBalances() as WalletBalances;
			if(walletBalances.OP.human < borrowAmount) {
				// Берем займ - проверено
				console.log(await borrowMoonwellAsset('OP', borrowAmount));
			}

			const hasEth = walletBalances.ETH.human;

			while (true) {
				await sleep(5000);
				walletBalances = await getWalletBalances() as WalletBalances;

				if(walletBalances.ETH.human > hasEth) {
					console.log('ETH от обмена поступил на баланс кошелька');
					break;
				}


				if(walletBalances.OP.human < borrowAmount) {
					console.log("Ожидается поступление OP на баланс кошелька....");

					continue;
				}



				let quote = await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
				quote = 1 / quote;

				console.log(await swapToEth("OP", borrowAmount, quote));
			}

			while (true) {
				await sleep(5000);
				walletBalances = await getWalletBalances() as WalletBalances;
				if (walletBalances.ETH.human > 0.01) {
					await supplyMoonwellAsset('ETH', (walletBalances['ETH']?.human ?? 0) - 0.004);

					break;
				}
			}
		}

		// Отдаем займ - тест
		//console.log(await repayMoonwellAsset('OP', borrowAmount));

		//console.log(await withdrawMoonwellAsset('ETH', supplyAmount)); // уменьшаем залог залог - проверка

		// Вносим залог - проверено
		//await supplyMoonwellAsset('ETH', (walletBalances['ETH']?.human ?? 0) - 0.004);

		await getMoonwellPositions(); // Детальный список позиций + корректировка

		return;

		await getUniswapPoolPrice(POOLS.OPT.EthOp03, provider);
		await getUniswapPoolPrice(POOLS.OPT.EthOp005, provider);
		await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
		await estimatePriceImpact(provider, borrowAmount, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
	}
}

main();
