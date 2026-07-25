import {CONFIG, currentNetwork, MOONWELL_MARKETS, type SupportedToken} from "../../config.js";
import {ethers} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";

export async function supplyMoonwellAsset(
	underlyingSymbol: SupportedToken, // Что вносим в залог ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов вносим в человеческом формате
): Promise<boolean> {
	console.log(`\n--- Moonwell Universal Supply: ${amountHuman} ${underlyingSymbol} (${CONFIG.CHAIN}) ---`);

	// Проверяем, авторизован ли кошелек
	if (!wallet) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}

	if (amountHuman <= 0) {
		console.log("Нельзя положить в залог отрицательное количество токенов");

		return false;
	}

	const networkKey = CONFIG.CHAIN as keyof typeof MOONWELL_MARKETS;

	const decimals = CONFIG.TOKEN_DECIMALS[underlyingSymbol as keyof typeof CONFIG.TOKEN_DECIMALS] ?? CONFIG.TOKEN_DECIMALS.default;
	const supplyAmountWei = ethers.parseUnits(amountHuman.toString(), decimals);

	try {
		if (underlyingSymbol === 'ETH') {
			if (CONFIG.CHAIN === 'OPT') {
				// todo отдельные методы для ETH и других
				// ABI для нативного роутера Moonwell (метод mint с указанием получателя)
				const routerAbi = ["function mint(address recipient) external payable returns (uint256)"];
				const routerContract = new ethers.Contract(MOONWELL_MARKETS.OPT.M_TOKENS.ETH_ROUTER, routerAbi, wallet);

				console.log(`Отправка ETH через официальный нативный роутер Moonwell...`);
				const tx = await routerContract.mint?.(wallet.address, {
					value: supplyAmountWei,
					gasLimit: 450000
				});

				const receipt = await tx.wait();
				if (receipt.status !== 1) throw new Error("Транзакция mint(ETH) завершилась ошибкой Revert");

				console.log("🎉 Нативный ETH успешно внесен в залог через роутер!");

				return true;
			}
		}

		const marketSymbol = (underlyingSymbol === 'ETH') ? 'WETH' : underlyingSymbol;
		const mTokenAddress = (MOONWELL_MARKETS[networkKey].M_TOKENS as any)[marketSymbol];

		if (!mTokenAddress) {
			throw new Error(`Токен ${underlyingSymbol} не поддерживается в константах Moonwell для сети ${CONFIG.CHAIN}`);
		}

		// ================= ВАРИАНТ 1: НАСТОЯЩИЙ НАТИВНЫЙ ETH (Если бы это был Base/Moonbeam) =================
		if (underlyingSymbol === 'ETH') {
			// todo отдельные методы для ETH и других
			const mTokenPayableAbi = ["function mint() external payable"];
			const mTokenContract = new ethers.Contract(mTokenAddress, mTokenPayableAbi, wallet) as any;

			console.log(`Отправка ${amountHuman} ETH напрямую в payable контракт...`);
			const txMint = await mTokenContract.mint({value: supplyAmountWei, gasLimit: 400000});
			const receipt = await txMint.wait();

			if (receipt.status !== 1) {
				throw new Error("Транзакция mint(ETH) завершилась ошибкой Revert");
			}

			console.log(`🎉 Нативный ETH успешно внесен в залог!`);
			await reportGasSpent(receipt);

			return true;
		}

		// ================= ВАРИАНТ 2: ERC-20 ТОКЕНЫ (USDC, OP, WETH) =================
		const underlyingTokenAddress = (currentNetwork.TOKENS as any)[underlyingSymbol];
		if (!underlyingTokenAddress) {
			throw new Error(`Не найден адрес базового токена для ${underlyingSymbol} в конфигурации сети`);
		}

		const mTokenExtendedAbi = [
			...CONFIG.ABI.MOONWELL,
			// todo отдельные методы для ETH и других
			"function mint(uint256 mintAmount) external returns (uint256)"
		];

		const tokenContract = new ethers.Contract(underlyingTokenAddress, CONFIG.ABI.ERC20_BALANCE_ABI, wallet);
		const mTokenContract = new ethers.Contract(mTokenAddress, mTokenExtendedAbi, wallet) as any;

		console.log(`Проверяем разрешения (allowance) для токена ${underlyingSymbol}...`);
		const currentAllowance: bigint = await tokenContract.allowance(wallet.address, mTokenAddress);

		if (currentAllowance < supplyAmountWei) {
			console.log(`Разрешений недостаточно. Отправляем Approve x10...`);
			const tenXApproveAmount = supplyAmountWei * 10n;
			const txApprove = await tokenContract.approve(mTokenAddress, tenXApproveAmount);
			await txApprove.wait();
			console.log("🟢 Approve успешно подтвержден.");
		}

		console.log(`Отправка транзакции mint на контракт рынка ${underlyingSymbol}...`);
		const txMint = await mTokenContract.mint(supplyAmountWei, {gasLimit: 500000}); // Подняли до 500k
		const receipt = await txMint.wait();

		if (receipt.status !== 1) {
			throw new Error("Транзакция mint завершилась ошибкой Revert");
		}

		console.log(`🎉 Токен ${underlyingSymbol} успешно внесен в залог!`);

		await reportGasSpent(receipt);

		return true;
	} catch (err: any) {
		console.error(`Ошибка при исполнении универсальной операции Supply в Moonwell:`, err.message);

		await reportErrorGasSpent(err);

		return false;
	}
}