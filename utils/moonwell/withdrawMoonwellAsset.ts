import { ethers, formatUnits } from "ethers";
import { CONFIG, getMoonwellMarkets, type ChainType, type SupportedToken } from "../../config.js";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallets} from "../loadWallet.js";

export async function withdrawMoonwellAsset(
	chain: ChainType,
	provider: ethers.JsonRpcProvider,
	underlyingSymbol: SupportedToken, // Что выводим ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов забрать на кошелек
) {
	const safeAmountString = amountHuman.toFixed(18);

	console.log(`\n--- Moonwell Universal Withdraw: ${amountHuman} ${underlyingSymbol} (${chain}) ---`);
	const signer = wallets[chain];
	if (!signer) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}

	// Для ETH и WETH рынок один и тот же — WETH контракт ядра
	const marketSymbol = (underlyingSymbol === 'ETH') ? 'WETH' : underlyingSymbol;
	const mTokenAddress = (getMoonwellMarkets(chain).M_TOKENS as any)[marketSymbol];

	if (!mTokenAddress) {
		throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах Moonwell для сети ${chain}`);
	}

	// Сигнатура external без возвращаемого значения (returns) для стабильной работы ethers.js v6
	const mTokenExtendedAbi = [
		...CONFIG.ABI.MOONWELL,
		"function redeemUnderlying(uint256 redeemAmount) external"
	];

	const mTokenContract = new ethers.Contract(mTokenAddress, mTokenExtendedAbi, signer) as any;

	try {
		const decimals = (underlyingSymbol === 'ETH')
			? 18
			: (CONFIG.TOKEN_DECIMALS[underlyingSymbol as keyof typeof CONFIG.TOKEN_DECIMALS] ?? 18);

		const withdrawAmountWei = ethers.parseUnits(safeAmountString, decimals);

		console.log(`Отправка транзакции redeemUnderlying на контракт рынка ${marketSymbol} (${mTokenAddress})...`);

		// 1. Запрашиваем текущую цену газа сети, чтобы полностью отключить симуляцию estimateGas
		const feeData = await provider.getFeeData();
		const currentGasPrice = feeData.gasPrice ?? BigInt(1000000); // 0.001 Gwei по умолчанию

		// 2. Отправляем транзакцию, принудительно передавая ВСЕ параметры газа
		const txWithdraw = await mTokenContract.redeemUnderlying(withdrawAmountWei, {
			gasLimit: 750000,
			gasPrice: currentGasPrice // dRPC больше не будет делать симуляцию и выдавать ошибку 400!
		});

		console.log(`Транзакция вывода отправлена. Хэш: ${txWithdraw.hash}. Ожидаем блоки...`);
		const receipt = await txWithdraw.wait();

		if (!receipt || receipt.status !== 1) {
			throw new Error("Транзакция redeemUnderlying завершилась ошибкой (Revert) на стороне блокчейна");
		}

		// ... ваш код проверки логов события Redeem ...

		console.log(`🎉 Вывод средств успешно завершен!`);
		return true;

	} catch (err: any) {
		// 3. БЕЗОПАСНЫЙ ПЕРЕХВАТ: Бот больше не упадет, а аккуратно зафиксирует сбой в вашей статистике
		console.error(`Ошибка при исполнении операции Withdraw в Moonwell:`, err.message);

		// Вызываем ваш метод разбора ошибок (он напечатает, что квитанции нет)
		if (typeof reportErrorGasSpent === "function") {
			await reportErrorGasSpent(err);
		}

		return false; // Бот продолжает жить и выполнять главный цикл
	}
}
