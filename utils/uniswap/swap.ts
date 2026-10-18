import { CONFIG, OPT_CHAIN, type ChainType, type SupportedToken } from "../../config.js";

import { ethers } from "ethers";
import { wallets } from "../loadWallet.js";

/**
 * Меняем нативный ETH на токен (например, OP)
 *
 * @param underlyingSymbol Токен, который хотим получить
 * @param amountHumanEth Количество ETH для обмена
 * @param quote {number} стоимость 1 ETH в целевых токенах
 */
export async function swapEthToOp(
	chain: ChainType,
	underlyingSymbol: SupportedToken, // OP
	amountHumanEth: number,
	quote: number
): Promise<boolean> {
	if (chain !== OPT_CHAIN) {
		throw new Error(`Uniswap swap is not configured for chain ${chain}`);
	}
	const signer = wallets[chain];
	if (!signer) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}
	const activeSigner = signer;
	const network = CONFIG.NETWORKS[chain];
	const wethAddress = network.TOKENS.WETH;
	const outputTokenAddress = network.TOKENS[underlyingSymbol];
	if (!wethAddress || !outputTokenAddress) {
		throw new Error(`Token address is not configured for ${underlyingSymbol} on ${chain}`);
	}
	const configuredWethAddress: string = wethAddress;
	const configuredOutputTokenAddress: string = outputTokenAddress;
	const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

	async function main() {
		// Переводим человеческое количество ETH в Wei
		const amountIn = ethers.parseUnits(amountHumanEth + '', 18);
		// Минимальное количество токенов на выход (защита от проскальзывания 1%)
		const amountOutMin = ethers.parseUnits((amountHumanEth * quote * 0.99).toFixed(18), 18);
		const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // Срок действия 10 минут

		const routerContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, CONFIG.ABI.UNISWAP_ROUTER, activeSigner) as any;

		// Шаг 1: Кодируем путь обмена WETH -> Пул 0.3% -> Целевой токен
		// Роутер автоматически заберет нативный ETH и обернет в WETH
		const path = ethers.solidityPacked(
			["address", "uint24", "address"],
			[configuredWethAddress, 3000, configuredOutputTokenAddress]
		);

		// Шаг 2: Подготовка параметров для exactInput
		const params = {
			path: path,
			recipient: activeSigner.address, // Токены сразу идут на ваш кошелек
			deadline: deadline,
			amountIn: amountIn,
			amountOutMinimum: amountOutMin
		};

		// Шаг 3: Отправка транзакции обмена
		// Approve не нужен, так как мы отправляем нативный ETH прямо в транзакции { value: amountIn }
		console.log("1. Отправка транзакции обмена ETH...");
		const tx = await routerContract.exactInput(params, {
			value: amountIn, // Передаем нативный эфир вместе с вызовом
			gasLimit: 350000
		});

		console.log(`Транзакция отправлена! Хэш: ${tx.hash}`);
		const receipt = await tx.wait();
		console.log(`Успешно исполнено в блоке: ${receipt.blockNumber}`);

		return true;
	}

	const res = await main().catch((error) => {
		console.error("Ошибка при выполнении скрипта swapEthToOp:", error);
		return false;
	});

	return res;
}

/**
 * Меняем 'underlyingSymbol' на нативный ETH
 *
 * @param underlyingSymbol Токен для обмена
 * @param amountHuman Количество токенов
 * @param quote {number} стоимость 'underlyingSymbol' в Эфирах
 */
export async function swapToEth(
	chain: ChainType,
	underlyingSymbol: SupportedToken,
	amountHuman: number,
	quote: number
): Promise<boolean> {
	if (chain !== OPT_CHAIN) {
		throw new Error(`Uniswap swap is not configured for chain ${chain}`);
	}
	const signer = wallets[chain];
	if (!signer) {
		console.error("❌ Ошибка: Действие невозможно. Кошелек не инициализирован (режим чтения).");
		return false;
	}
	const activeSigner = signer;
	const network = CONFIG.NETWORKS[chain];
	const wethAddress = network.TOKENS.WETH;
	const inputTokenAddress = network.TOKENS[underlyingSymbol];
	if (!wethAddress || !inputTokenAddress) {
		throw new Error(`Token address is not configured for ${underlyingSymbol} on ${chain}`);
	}
	const configuredWethAddress: string = wethAddress;
	const configuredInputTokenAddress: string = inputTokenAddress;
	const SWAP_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

	async function main() {
		const amountIn = ethers.parseUnits(amountHuman + '', 18);
		const amountOutMin = ethers.parseUnits((quote * amountHuman * 0.99).toFixed(18), 18);   // Минимальный ETH (защита от проскальзывания)
		const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // Срок действия 10 минут

		const routerContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, CONFIG.ABI.UNISWAP_ROUTER, activeSigner) as any;
		const opContract = new ethers.Contract(configuredInputTokenAddress, CONFIG.ABI.ERC20_BALANCE_ABI, activeSigner) as any;

		// Шаг 1: Одобряем роутеру трату токенов OP
		console.log("1. Отправка Approve...");
		const approveTx = await opContract.approve(SWAP_ROUTER_ADDRESS, amountIn);
		await approveTx.wait();
		console.log("Аппрув успешно подтвержден!");

		// Шаг 2: Кодируем путь обмена OP -> Пул 0.3% -> WETH
		// 3000 bps в Uniswap соответствует пулу с комиссией 0.3%
		const path = ethers.solidityPacked(
			["address", "uint24", "address"],
			[configuredInputTokenAddress, 3000, configuredWethAddress]
		);

		// Шаг 3: Кодируем внутренние вызовы для Multicall
		console.log("2. Подготовка вызовов внутри пакета (Multicall)...");

		// Инструкция А: Своп OP на WETH.
		// ВНИМАНИЕ: Получателем (recipient) ставим адрес самого Роутера (адрес 2), чтобы он мог тут же развернуть WETH
		const exactInputData = routerContract.interface.encodeFunctionData("exactInput", [{
			path: path,
			recipient: SWAP_ROUTER_ADDRESS, // WETH временно идет на контракт роутера
			deadline: deadline,
			amountIn: amountIn,
			amountOutMinimum: amountOutMin
		}]);

		// Инструкция Б: Роутер забирает полученный WETH, разворачивает в ETH и отправляет на ваш кошелек
		const unwrapWETH9Data = routerContract.interface.encodeFunctionData("unwrapWETH9", [
			amountOutMin,   // Минимальное количество на выход
			activeSigner.address  // Конечный получатель нативного ETH (ваш кошелек)
		]);

		// Шаг 4: Упаковываем обе инструкции в один массив и отправляем одну транзакцию
		console.log("3. Отправка транзакции обмена...");
		const tx = await routerContract.multicall([exactInputData, unwrapWETH9Data], {
			gasLimit: 350000 // Лимит с запасом, OPT спишет копейки по факту
		});

		console.log(`Транзакция отправлена! Хэш: ${tx.hash}`);
		const receipt = await tx.wait();
		console.log(`Успешно исполнено в блоке: ${receipt.blockNumber}`);

		return true
	}

	const res = await main().catch((error) => {
		console.error("Ошибка при выполнении скрипта:", error);

		return false;
	});

	return res;
}
