import {CONFIG, currentNetwork, MOONWELL_MARKETS, type SupportedToken} from "../../config.js";
import {ethers, formatUnits} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";

export async function repayMoonwellAsset(
	underlyingSymbol: SupportedToken, // Какой долг гасим ('USDC', 'OP', 'WETH')
	amountHuman: number               // Сколько токенов хотим вернуть
) {
	console.log(`\n--- Moonwell Repay Initialization: ${amountHuman} ${underlyingSymbol} (${CONFIG.CHAIN}) ---`);

	// Проверяем, авторизован ли кошелек
	if (!wallet) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}

	const networkKey = CONFIG.CHAIN as keyof typeof MOONWELL_MARKETS;
	const mTokenAddress = (MOONWELL_MARKETS[networkKey].M_TOKENS as any)[underlyingSymbol];

	if (!mTokenAddress) {
		throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах Moonwell для сети ${CONFIG.CHAIN}`);
	}

	// Извлекаем адрес оригинального ERC-20 токена из конфигурации сети
	const underlyingTokenAddress = (currentNetwork.TOKENS as any)[underlyingSymbol];
	if (!underlyingTokenAddress) {
		throw new Error(`Не найден адрес базового токена для ${underlyingSymbol} в конфигурации сети`);
	}

	const mTokenExtendedAbi = [
		...CONFIG.ABI.MOONWELL,
		"function repayBorrow(uint256 repayAmount) external",
		"function borrowBalanceStored(address account) view returns (uint256)"
	];

	const tokenContract = new ethers.Contract(underlyingTokenAddress, CONFIG.ABI.ERC20_BALANCE_ABI, wallet);
	const mTokenContract = new ethers.Contract(mTokenAddress, mTokenExtendedAbi, wallet) as any;

	try {
		// Переводим человеческую сумму в Wei с учетом decimals токена
		const decimals = CONFIG.TOKEN_DECIMALS[underlyingSymbol as keyof typeof CONFIG.TOKEN_DECIMALS] ?? 18;
		let amountToRepayWei = ethers.parseUnits(amountHuman.toString(), decimals);

		// ================= БЛОК ЗАЩИТНЫХ ПРОВЕРОК БАЛАНСОВ =================
		console.log(`Проверяем балансы и задолженность для ${underlyingSymbol}...`);

		// 1. Проверяем реальный баланс токенов на кошельке
		const walletBalanceWei: bigint = await tokenContract.balanceOf(wallet.address);
		const walletBalanceHuman = formatUnits(walletBalanceWei, decimals);

		if (walletBalanceWei === 0n) {
			console.log(`⚠️ У вас нет токенов ${underlyingSymbol} в кошельке`);

			return false;
		}

		// 2. Проверяем точный текущий долг в Moonwell
		const currentBorrowBalanceWei: bigint = await mTokenContract.borrowBalanceStored(wallet.address);
		const currentBorrowHuman = formatUnits(currentBorrowBalanceWei, decimals);

		console.log(`- Баланс кошелька:   ${walletBalanceHuman} ${underlyingSymbol}`);
		console.log(`- Текущий долг:      ${currentBorrowHuman} ${underlyingSymbol}`);

		if (currentBorrowBalanceWei === 0n) {
			console.log(`🟢 У вас нет активного долга по токену ${underlyingSymbol}. Погашение не требуется.`);

			return false;
		}

		// КОРРЕКТИРОВКА 1: Защита от переплаты (если запросили больше реального долга)
		if (amountToRepayWei > currentBorrowBalanceWei) {
			console.log(`⚠️ Запрошено погашение (${amountHuman}), превышающее долг. Снижаем до размера долга.`);
			amountToRepayWei = currentBorrowBalanceWei;
		}

		// КОРРЕКТИРОВКА 2: Защита от нехватки средств на кошельке
		if (amountToRepayWei > walletBalanceWei) {
			console.log(`⚠️ На кошельке нет нужной суммы. Погашаем на весь доступный баланс: ${walletBalanceHuman} ${underlyingSymbol}`);
			amountToRepayWei = walletBalanceWei;
		}

		// Оставляем флаг полного закрытия долга, если гасим 100% оставшейся задолженности
		const isFullRepay = (amountToRepayWei === currentBorrowBalanceWei);
		const finalRepayAmountWei = isFullRepay ? ethers.MaxUint256 : amountToRepayWei;
		const approveAmount = isFullRepay ? currentBorrowBalanceWei : amountToRepayWei;

		// ================= APPROVE И ОТПРАВКА =================
		console.log(`Проверяем разрешения (allowance)...`);
		const currentAllowance: bigint = await tokenContract.allowance(wallet.address, mTokenAddress);

		if (currentAllowance < approveAmount) {
			// Рассчитываем сумму аппрува с запасом х10 от необходимой
			const tenXApproveAmount = approveAmount * 10n;

			console.log(`Разрешений недостаточно (Есть: ${formatUnits(currentAllowance, decimals)}).`);
			console.log(`Отправляем Approve с ЗАПАСОМ х10 на сумму: ${formatUnits(tenXApproveAmount, decimals)} ${underlyingSymbol}...`);

			const txApprove = await tokenContract.approve(mTokenAddress, tenXApproveAmount);
			await txApprove.wait();
			console.log("🟢 Большой Approve подтвержден блокчейном. Следующие ~9 транзакций пройдут без аппрува.");
		}

		console.log(`Отправка транзакции repayBorrow...`);
		const txRepay = await mTokenContract.repayBorrow(finalRepayAmountWei, {gasLimit: 500000});

		console.log(`Транзакция отправлена: ${txRepay.hash}. Ожидаем подтверждения...`);
		const receipt = await txRepay.wait();

		if (!receipt || receipt.status !== 1) {
			throw new Error("Транзакция завершилась ошибкой (Revert) на стороне блокчейна");
		}

		await reportGasSpent(receipt);

		// Верификация по нативному хэшу события RepayBorrow
		const mTokenInterface = new ethers.Interface([
			"event RepayBorrow(address payer, address borrower, uint256 repayAmount, uint256 accountBorrows, uint256 totalBorrows)"
		]);
		const REPAY_EVENT_TOPIC = mTokenInterface.getEvent("RepayBorrow")?.topicHash;

		const hasRepayLog = receipt.logs.some((log: any) =>
			log.address.toLowerCase() === mTokenAddress.toLowerCase() &&
			log.topics && log.topics[0] === REPAY_EVENT_TOPIC
		);

		if (!hasRepayLog) {
			throw new Error("❌ Ошибка: событие RepayBorrow не найдено в логах транзакции!");
		}

		console.log(`🎉 Погашение успешно выполнено!`);

		return true;
	} catch (err: any) {
		console.error(`Ошибка при исполнении операции Repay в Moonwell:`, err.message);

		await reportErrorGasSpent(err);

		return false;
	}
}