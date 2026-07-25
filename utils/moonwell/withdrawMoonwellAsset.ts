import { ethers, formatUnits } from "ethers";
import {CONFIG, currentNetwork, MOONWELL_MARKETS, type SupportedToken} from "../../config.js";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";

export async function withdrawMoonwellAsset(
	underlyingSymbol: SupportedToken, // Что выводим ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов забрать на кошелек
) {
	console.log(`\n--- Moonwell Universal Withdraw: ${amountHuman} ${underlyingSymbol} (${CONFIG.CHAIN}) ---`);

	const networkKey = CONFIG.CHAIN as keyof typeof MOONWELL_MARKETS;

	// Для ETH и WETH рынок один и тот же — WETH контракт ядра
	const marketSymbol = (underlyingSymbol === 'ETH') ? 'WETH' : underlyingSymbol;
	const mTokenAddress = (MOONWELL_MARKETS[networkKey].M_TOKENS as any)[marketSymbol];

	if (!mTokenAddress) {
		throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах Moonwell для сети ${CONFIG.CHAIN}`);
	}

	// Сигнатура external без возвращаемого значения (returns) для стабильной работы ethers.js v6
	const mTokenExtendedAbi = [
		...CONFIG.ABI.MOONWELL,
		"function redeemUnderlying(uint256 redeemAmount) external"
	];

	const mTokenContract = new ethers.Contract(mTokenAddress, mTokenExtendedAbi, wallet) as any;

	try {
		const decimals = (underlyingSymbol === 'ETH')
			? 18
			: (CONFIG.TOKEN_DECIMALS[underlyingSymbol as keyof typeof CONFIG.TOKEN_DECIMALS] ?? 18);

		const withdrawAmountWei = ethers.parseUnits(amountHuman.toString(), decimals);

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


export async function withdrawMoonwellAsset_old(
	underlyingSymbol: SupportedToken, // Что выводим ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов забрать на кошелек
) {
	console.log(`\n--- Moonwell Universal Withdraw: ${amountHuman} ${underlyingSymbol} (${CONFIG.CHAIN}) ---`);
	// Проверяем, авторизован ли кошелек
	if (!wallet) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}

	// Определяем символ рынка (для ETH и WETH рынок один и тот же — WETH)
	const marketSymbol = (underlyingSymbol === 'ETH') ? 'WETH' : underlyingSymbol;
	const mTokenAddress = (MOONWELL_MARKETS[CONFIG.CHAIN].M_TOKENS as any)[marketSymbol];

	if (!mTokenAddress) {
		throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах Moonwell для сети ${CONFIG.CHAIN}`);
	}

	try {
		const decimals = (underlyingSymbol === 'ETH')
			? 18
			: (CONFIG.TOKEN_DECIMALS[underlyingSymbol as keyof typeof CONFIG.TOKEN_DECIMALS] ?? 18);

		const withdrawAmountWei = ethers.parseUnits(amountHuman.toString(), decimals);

		// ================= ВАРИАНТ 1: ВЫВОД НАТИВНОГО ETH НА OPTIMISM =================
		if (underlyingSymbol === 'ETH' && CONFIG.CHAIN === 'OPT') {
			// ABI нативного роутера для вывода ETH (метод redeemUnderlying)
			const routerAbi = [
				"function redeemUnderlying(address recipient, uint256 redeemAmount) external returns (uint256)",
			];

			// ABI для оригинального mToken (mWETH), чтобы сделать Approve роутеру
			const mTokenApproveAbi = [
				"function approve(address spender, uint256 amount) external returns (bool)",
				"function allowance(address owner, address spender) view returns (uint256)"
			];

			// Инициализируем контракт mWETH (mToken Address для эфира) с ABI для аппрува
			const mWethContract = new ethers.Contract(mTokenAddress, mTokenApproveAbi, wallet);

			console.log(`Проверяем разрешения для роутера на списание ваших mWETH...`);
			// Запрашиваем лимит. При выводе 0.01 ETH спишется чуть меньше или больше mWETH (из-за exchangeRate),
			// поэтому для безопасности лучше аппрувнуть сумму с запасом х10 или MaxUint256
			const currentMAllowance: bigint = await mWethContract.allowance?.(wallet.address, MOONWELL_MARKETS.OPT.M_TOKENS.ETH_ROUTER);

			// Так как курс обмена mToken к ETH динамический (~0.02), аппрувим MaxUint256, чтобы не тратить газ дважды
			if (currentMAllowance < ethers.parseEther("1")) {
				console.log("Разрешений для роутера недостаточно. Отправляем Approve для mWETH...");
				const txMApprove = await mWethContract.approve?.(MOONWELL_MARKETS.OPT.M_TOKENS.ETH_ROUTER, ethers.MaxUint256);
				await txMApprove.wait();
				console.log("🟢 Роутер авторизован для сжигания mWETH.");
			}


			const routerContract = new ethers.Contract(MOONWELL_MARKETS.OPT.M_TOKENS.ETH_ROUTER, routerAbi, wallet);

			console.log(`Отправка транзакции redeemUnderlying через нативный роутер Moonwell для получения ETH...`);

			const tx = await routerContract.redeemUnderlying?.(wallet.address, withdrawAmountWei, {
				gasLimit: 600000 // Запас газа для проведения операции и развертывания WETH -> ETH
			});

			const receipt = await tx.wait();
			if (!receipt || receipt.status !== 1) throw new Error("Транзакция роутера завершилась ошибкой Revert");

			console.log(`🎉 Нативный ETH успешно выведен из залога на ваш кошелек!`);

			await reportGasSpent(receipt);

			return true;
		}

		// ================= ВАРИАНТ 2: ВЫВОД СТАНДАРТНЫХ ERC-20 ТОКЕНОВ (USDC, OP, WETH) =================
		const mTokenExtendedAbi = [
			...CONFIG.ABI.MOONWELL,
			"function redeemUnderlying(uint256 redeemAmount) external" // external без returns для ethers v6
		];

		const mTokenContract = new ethers.Contract(mTokenAddress, mTokenExtendedAbi, wallet) as any;

		console.log(`Отправка транзакции redeemUnderlying на контракт рынка ${marketSymbol}...`);
		const txWithdraw = await mTokenContract.redeemUnderlying(withdrawAmountWei, {
			gasLimit: 500000 // Безопасный лимит газа для L2
		});

		console.log(`Транзакция вывода отправлена. Хэш: ${txWithdraw.hash}. Ожидаем подтверждения...`);
		const receipt = await txWithdraw.wait();

		if (!receipt || receipt.status !== 1) {
			throw new Error("Транзакция redeemUnderlying завершилась ошибкой (Revert) на стороне блокчейна");
		}

		// ================= НИЗКОУРОВНЕВАЯ ВЕРИФИКАЦИЯ УСПЕХА ПО ЛОГАМ =================
		// При успешном выводе контракт обязан эмитировать событие Redeem(address redeemer, uint256 redeemAmount, uint256 redeemTokens)
		// Генерируем хэш события на лету, чтобы исключить опечатки хардкода
		const mTokenInterface = new ethers.Interface([
			"event Redeem(address redeemer, uint256 redeemAmount, uint256 redeemTokens)"
		]);
		const REDEEM_EVENT_TOPIC = mTokenInterface.getEvent("Redeem")?.topicHash;

		const hasRedeemLog = receipt.logs.some((log: any) =>
			log.address.toLowerCase() === mTokenAddress.toLowerCase() &&
			log.topics && log.topics[0] === REDEEM_EVENT_TOPIC
		);

		if (!hasRedeemLog) {
			throw new Error("❌ Ошибка: статус транзакции Success, но событие Redeem не найдено в логах блокчейна!");
		}

		console.log(`🎉 Вывод средств успешно завершен! ${amountHuman} ${underlyingSymbol} зачислено на кошелек.`);

		await reportGasSpent(receipt);

		return true;

	} catch (err: any) {
		console.error(`Ошибка при исполнении операции Withdraw в Moonwell:`, err.message);

		await reportErrorGasSpent(err);

		return false;
	}
}
