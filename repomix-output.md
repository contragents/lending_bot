This file is a merged representation of a subset of the codebase, containing specifically included files and files not matching ignore patterns, combined into a single document by Repomix.
The content has been processed where line numbers have been added, content has been compressed (code blocks are separated by ⋮---- delimiter).

# File Summary

## Purpose
This file contains a packed representation of a subset of the repository's contents that is considered the most important context.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Only files matching these patterns are included: **/*.ts
- Files matching these patterns are excluded: .env, repomix.config.json
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Line numbers have been added to the beginning of each line
- Content has been compressed - code blocks are separated by ⋮---- delimiter
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
classes/
  HLPosition.ts
  MoonwellPosition.ts
  MorphoPosition.ts
  Position.ts
utils/
  hyperliquid/
    transformer.ts
  invest_legal/
    recommend.ts
  moonwell/
    borrowAsset.ts
    getMoonwellData.ts
    repayAsset.ts
    supplyMoonwellAsset.ts
    withdrawMoonwellAsset.ts
  uniswap/
    swap.ts
  loadWallet.ts
  utils.ts
config.ts
createKeystore.ts
index.ts
moonwellUtils.ts
```

# Files

## File: utils/invest_legal/recommend.ts
```typescript
import axios from "axios";
⋮----
// Внутренние интерфейсы для строгой типизации ответов сервера
interface LendingSuccessResponse {
	result?: never;
	"0": string;
	raw_data: {
		withdraw?: Record<string, number>;
		repay?: Record<string, number>;
		supply?: Record<string, number>;
		borrow?: Record<string, number>;

		deloop?: Record<string, number>;
		loop?: Record<string, number>;
	};
}
⋮----
interface LendingErrorResponse {
	result: "error";
	message: string;
}
⋮----
type LendingApiResponse = LendingSuccessResponse | LendingErrorResponse;
⋮----
// Описываем возвращаемый тип функции согласно вашему требованию
export interface LendingLeverageResult {
	deloop?: Record<string, number>;
	loop?: Record<string, number>;
}
⋮----
/**
 * Получает инструкцию из lending пула и извлекает параметры поддержки плеча (loop/deloop).
 *
 * @param lendingId Идентификатор lending пула
 * @returns Объект с параметрами loop/deloop или пустой объект {} в случае ошибки
 */
export async function fetchLendingInstruction(lendingId: number): Promise<LendingLeverageResult>
⋮----
// 1. Обработка внутренней ошибки бизнес-логики API
⋮----
// 2. Извлекаем данные, если они существуют
⋮----
// Наполняем возвращаемый объект только теми полями, которые пришли от сервера
⋮----
// 3. Обработка сетевых ошибок (404, 500, таймауты)
```

## File: createKeystore.ts
```typescript
import { ethers } from 'ethers';
⋮----
async function createKeystore()
⋮----
const privateKey = ""; // Вставьте реальный ключ
const password = ""; // Придумайте пароль
⋮----
// encrypt() генерирует JSON-строку по стандарту Ethereum
⋮----
//    fs.writeFileSync('wallet.json', encryptedJson);
```

## File: classes/MoonwellPosition.ts
```typescript
import {ethers, formatUnits} from "ethers";
import {CONFIG, getEnv, getMoonwellMarkets, LENDING, OPT_CHAIN, POOLS, type ChainType, type SupportedToken, type WalletBalances, WATCH_ADDRESS} from "../config.js";
import {Position} from "./Position.js";
import {fetchLendingInstruction, type LendingLeverageResult} from "../utils/invest_legal/recommend.js";
import {borrowMoonwellAsset} from "../utils/moonwell/borrowAsset.js";
import {repayMoonwellAsset} from "../utils/moonwell/repayAsset.js";
import {supplyMoonwellAsset} from "../utils/moonwell/supplyMoonwellAsset.js";
import {withdrawMoonwellAsset} from "../utils/moonwell/withdrawMoonwellAsset.js";
import {swapEthToOp, swapToEth} from "../utils/uniswap/swap.js";
import {getUniswapPoolPrice, getWalletBalances, sleep, withRetry} from "../utils/utils.js";
import {wallet} from "../utils/loadWallet.js";
⋮----
function getHumanBalance(balances: WalletBalances, token: SupportedToken): number
⋮----
export class MoonwellPosition extends Position {
⋮----
constructor(
        private readonly chain: ChainType,
        private readonly provider: ethers.JsonRpcProvider
)
⋮----
async getPosition(): Promise<boolean>
⋮----
async reportPosition(): Promise<boolean>
⋮----
async getRecommend(): Promise<LendingLeverageResult>
⋮----
async loop(borrowAmount: number): Promise<void>
⋮----
async deLoop(supplyAmount: number): Promise<void>
⋮----
private async calculateMoonwellAPY(mToken: ethers.Contract): Promise<[string, string]>
```

## File: classes/MorphoPosition.ts
```typescript
import {ethers, formatUnits} from "ethers";
import {BASE_CHAIN, CONFIG, getEnv, LENDING, WATCH_ADDRESS} from "../config.js";
import {Position} from "./Position.js";
import {withRetry} from "../utils/utils.js";
⋮----
export class MorphoPosition extends Position {
⋮----
constructor(private readonly provider: ethers.JsonRpcProvider)
⋮----
async getPosition(): Promise<boolean>
⋮----
async reportPosition(): Promise<boolean>
```

## File: utils/hyperliquid/transformer.ts
```typescript
// Определяем обновленные структуры под формат ваших моделей лендинга
export type LandingAssetItem = {
    token: string;
    amount: number;
    price: number; // 👈 Добавлено поле текущей цены
};
⋮----
price: number; // 👈 Добавлено поле текущей цены
⋮----
export type LandingModelData = {
    supply: LandingAssetItem[];
    borrow: LandingAssetItem[];
};
⋮----
// Входные интерфейсы
interface HyperliquidDataInput {
    totalEquity: number;
    longs: Array<{ coin: string; szi: string; positionValue: string }>;
    shorts: Array<{ coin: string; szi: string; positionValue: string }>;
}
⋮----
/**
 * Трансформирует перп-портфель Hyperliquid в классическую модель Лендинга (Supply/Borrow).
 * Гарантирует, что формула (Total Supply Value - Total Borrow Value) будет равна Total Equity.
 */
export function transformHyperliquidToLandingModel(data: HyperliquidDataInput): LandingModelData
⋮----
// Вспомогательная функция для безопасного расчета текущей рыночной цены
const calculatePrice = (positionValue: string, szi: string): number =>
⋮----
// 1. Агрегируем списки позиций в формат (Токен, Количество, Цена)
// Для лонгов вычисляем маркет-прайс на основе текущего номинала и размера
⋮----
price: calculatePrice(p.positionValue, p.szi) // 👈 Расчет цены лонга
⋮----
// Для шортов аналогично рассчитываем цену
⋮----
price: calculatePrice(p.positionValue, p.szi) // 👈 Расчет цены шорта
⋮----
// 2. Рассчитываем совокупные долларовые номиналы позиций (Notional Value)
⋮----
// 3. Вычисляем корректирующую величину виртуального USDC
⋮----
// 4. Добавляем корректирующий USDC в модель Supply с фиксированной ценой $1
⋮----
price: 1 // 👈 Цена стейблкоина всегда равна 1
```

## File: utils/moonwell/borrowAsset.ts
```typescript
import {CONFIG, getMoonwellMarkets, type ChainType, type SupportedToken} from "../../config.js";
import {ethers} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";
⋮----
export async function borrowMoonwellAsset(
	chain: ChainType,
	underlyingSymbol: SupportedToken,
	amountHuman: number
): Promise<boolean>
⋮----
// Проверяем, авторизован ли кошелек
⋮----
// 1. Извлекаем адрес напрямую из константы по текущей сети
⋮----
// Расчет суммы займа в Wei
⋮----
// 2. Вызов borrow
⋮----
// Константный хэш события Borrow(address borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)
// Мы взяли его напрямую из успешного лога вашей транзакции (индекс 58)
⋮----
// Проверяем, есть ли этот хэш в Topic 0 хотя бы одного лога от нашего mToken контракта
```

## File: utils/moonwell/getMoonwellData.ts
```typescript
import {CONFIG, type ChainType, WATCH_ADDRESS} from "../../config.js";
import {ethers} from "ethers";
import {withRetry} from "../utils.js";
⋮----
export async function getMoonwellData(chain: ChainType, provider: ethers.JsonRpcProvider)
⋮----
// Возвращает: (error, liquidity, shortfall)
// Liquidity > 0 означает, что заем безопасен. Shortfall > 0 означает риск ликвидации.
```

## File: utils/moonwell/repayAsset.ts
```typescript
import {CONFIG, getMoonwellMarkets, type ChainType, type SupportedToken} from "../../config.js";
import {ethers, formatUnits} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";
⋮----
export async function repayMoonwellAsset(
	chain: ChainType,
	underlyingSymbol: SupportedToken, // Какой долг гасим ('USDC', 'OP', 'WETH')
	amountHuman: number               // Сколько токенов хотим вернуть
)
⋮----
underlyingSymbol: SupportedToken, // Какой долг гасим ('USDC', 'OP', 'WETH')
amountHuman: number               // Сколько токенов хотим вернуть
⋮----
// Проверяем, авторизован ли кошелек
⋮----
// Извлекаем адрес оригинального ERC-20 токена из конфигурации сети
⋮----
// Переводим человеческую сумму в Wei с учетом decimals токена
⋮----
// ================= БЛОК ЗАЩИТНЫХ ПРОВЕРОК БАЛАНСОВ =================
⋮----
// 1. Проверяем реальный баланс токенов на кошельке
⋮----
// 2. Проверяем точный текущий долг в Moonwell
⋮----
// КОРРЕКТИРОВКА 1: Защита от переплаты (если запросили больше реального долга)
⋮----
// КОРРЕКТИРОВКА 2: Защита от нехватки средств на кошельке
⋮----
// Оставляем флаг полного закрытия долга, если гасим 100% оставшейся задолженности
⋮----
// ================= APPROVE И ОТПРАВКА =================
⋮----
// Рассчитываем сумму аппрува с запасом х10 от необходимой
⋮----
// Верификация по нативному хэшу события RepayBorrow
```

## File: utils/loadWallet.ts
```typescript
import {ethers} from "ethers";
import {getEnv} from "../config.js";
import readline from "readline/promises";
import {HDNodeWallet, Wallet} from "ethers";
⋮----
async function loadWallet(provider: ethers.Provider)
⋮----
// Запрашиваем пароль в консоли (безопаснее, чем хранить в .env)
⋮----
// Восстанавливаем кошелек
⋮----
export async function initializeWallet(provider: ethers.Provider): Promise<void>
```

## File: classes/Position.ts
```typescript
import type {LendingLeverageResult} from "../utils/invest_legal/recommend.js";
import {getEnv} from "../config.js";
⋮----
export type PositionAssets = {
    supply: Record<string, number>;
    borrow: Record<string, number>;
};
⋮----
export abstract class Position {
⋮----
abstract getPosition(): Promise<boolean>;
abstract reportPosition(): Promise<boolean>;
⋮----
async getRecommend(): Promise<LendingLeverageResult>
⋮----
async loop(_amount: number): Promise<void>
⋮----
async deLoop(_amount: number): Promise<void>
⋮----
protected createReportParams(assets: PositionAssets): URLSearchParams
⋮----
protected createReportUrl(params: URLSearchParams): URL
```

## File: utils/moonwell/supplyMoonwellAsset.ts
```typescript
import {CONFIG, getMoonwellMarkets, MOONWELL_MARKETS, OPT_CHAIN, type ChainType, type SupportedToken} from "../../config.js";
import {ethers} from "ethers";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";
⋮----
export async function supplyMoonwellAsset(
	chain: ChainType,
	underlyingSymbol: SupportedToken, // Что вносим в залог ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов вносим в человеческом формате
): Promise<boolean>
⋮----
underlyingSymbol: SupportedToken, // Что вносим в залог ('USDC', 'OP', 'ETH', 'WETH')
amountHuman: number               // Сколько токенов вносим в человеческом формате
⋮----
// Проверяем, авторизован ли кошелек
⋮----
// todo отдельные методы для ETH и других
// ABI для нативного роутера Moonwell (метод mint с указанием получателя)
⋮----
// ================= ВАРИАНТ 1: НАСТОЯЩИЙ НАТИВНЫЙ ETH (Если бы это был BASE/Moonbeam) =================
⋮----
// todo отдельные методы для ETH и других
⋮----
// ================= ВАРИАНТ 2: ERC-20 ТОКЕНЫ (USDC, OP, WETH) =================
⋮----
// todo отдельные методы для ETH и других
⋮----
const txMint = await mTokenContract.mint(supplyAmountWei, {gasLimit: 500000}); // Подняли до 500k
```

## File: classes/HLPosition.ts
```typescript
import {WATCH_ADDRESS} from "../config.js";
import {Position} from "./Position.js";
⋮----
type HyperliquidPositionData = {
    coin: string;
    szi: string;
    leverage: {
        type: string;
        value: number;
    };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    liquidationPx: string | null;
    marginUsed: string;
};
⋮----
type ClearinghouseState = {
    marginSummary: { accountValue: string };
    crossMaintenanceMarginUsed: string;
    assetPositions: { position: HyperliquidPositionData }[];
};
⋮----
type SpotTokenBalance = {
    coin: string;
    total: string;
};
⋮----
type SpotClearinghouseState = {
    balances: SpotTokenBalance[];
};
⋮----
function isRecord(value: unknown): value is Record<string, unknown>
⋮----
function isNumericString(value: unknown): value is string
⋮----
function isHyperliquidPosition(value: unknown): value is HyperliquidPositionData
⋮----
function isClearinghouseState(value: unknown): value is ClearinghouseState
⋮----
function isSpotClearinghouseState(value: unknown): value is SpotClearinghouseState
⋮----
async function postToHyperliquidInfo(type: string): Promise<unknown>
⋮----
export class HLPosition extends Position {
⋮----
async getPosition(): Promise<boolean>
⋮----
// SUM USDC position for LONG and SHORT separately
⋮----
// Correcting borrow position
⋮----
async reportPosition(): Promise<boolean>
```

## File: utils/moonwell/withdrawMoonwellAsset.ts
```typescript
import { ethers, formatUnits } from "ethers";
import { CONFIG, getMoonwellMarkets, type ChainType, type SupportedToken } from "../../config.js";
import {reportErrorGasSpent, reportGasSpent} from "../utils.js";
import {wallet} from "../loadWallet.js";
⋮----
export async function withdrawMoonwellAsset(
	chain: ChainType,
	provider: ethers.JsonRpcProvider,
	underlyingSymbol: SupportedToken, // Что выводим ('USDC', 'OP', 'ETH', 'WETH')
	amountHuman: number               // Сколько токенов забрать на кошелек
)
⋮----
underlyingSymbol: SupportedToken, // Что выводим ('USDC', 'OP', 'ETH', 'WETH')
amountHuman: number               // Сколько токенов забрать на кошелек
⋮----
// Для ETH и WETH рынок один и тот же — WETH контракт ядра
⋮----
// Сигнатура external без возвращаемого значения (returns) для стабильной работы ethers.js v6
⋮----
// 1. Запрашиваем текущую цену газа сети, чтобы полностью отключить симуляцию estimateGas
⋮----
const currentGasPrice = feeData.gasPrice ?? BigInt(1000000); // 0.001 Gwei по умолчанию
⋮----
// 2. Отправляем транзакцию, принудительно передавая ВСЕ параметры газа
⋮----
gasPrice: currentGasPrice // dRPC больше не будет делать симуляцию и выдавать ошибку 400!
⋮----
// ... ваш код проверки логов события Redeem ...
⋮----
// 3. БЕЗОПАСНЫЙ ПЕРЕХВАТ: Бот больше не упадет, а аккуратно зафиксирует сбой в вашей статистике
⋮----
// Вызываем ваш метод разбора ошибок (он напечатает, что квитанции нет)
⋮----
return false; // Бот продолжает жить и выполнять главный цикл
```

## File: utils/uniswap/swap.ts
```typescript
import { CONFIG, OPT_CHAIN, type ChainType, type SupportedToken } from "../../config.js";
⋮----
import { ethers } from "ethers";
import { wallet } from "../loadWallet.js";
⋮----
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
): Promise<boolean>
⋮----
underlyingSymbol: SupportedToken, // OP
⋮----
async function main()
⋮----
// Переводим человеческое количество ETH в Wei
⋮----
// Минимальное количество токенов на выход (защита от проскальзывания 1%)
⋮----
const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // Срок действия 10 минут
⋮----
// Шаг 1: Кодируем путь обмена WETH -> Пул 0.3% -> Целевой токен
// Роутер автоматически заберет нативный ETH и обернет в WETH
⋮----
// Шаг 2: Подготовка параметров для exactInput
⋮----
recipient: signer.address, // Токены сразу идут на ваш кошелек
⋮----
// Шаг 3: Отправка транзакции обмена
// Approve не нужен, так как мы отправляем нативный ETH прямо в транзакции { value: amountIn }
⋮----
value: amountIn, // Передаем нативный эфир вместе с вызовом
⋮----
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
): Promise<boolean>
⋮----
const amountOutMin = ethers.parseUnits((quote * amountHuman * 0.99).toFixed(18), 18);   // Минимальный ETH (защита от проскальзывания)
const deadline = Math.floor(Date.now() / 1000) + 60 * 10; // Срок действия 10 минут
⋮----
// Шаг 1: Одобряем роутеру трату токенов OP
⋮----
// Шаг 2: Кодируем путь обмена OP -> Пул 0.3% -> WETH
// 3000 bps в Uniswap соответствует пулу с комиссией 0.3%
⋮----
// Шаг 3: Кодируем внутренние вызовы для Multicall
⋮----
// Инструкция А: Своп OP на WETH.
// ВНИМАНИЕ: Получателем (recipient) ставим адрес самого Роутера (адрес 2), чтобы он мог тут же развернуть WETH
⋮----
recipient: SWAP_ROUTER_ADDRESS, // WETH временно идет на контракт роутера
⋮----
// Инструкция Б: Роутер забирает полученный WETH, разворачивает в ETH и отправляет на ваш кошелек
⋮----
amountOutMin,   // Минимальное количество на выход
signer.address  // Конечный получатель нативного ETH (ваш кошелек)
⋮----
// Шаг 4: Упаковываем обе инструкции в один массив и отправляем одну транзакцию
⋮----
gasLimit: 350000 // Лимит с запасом, OPT спишет копейки по факту
```

## File: utils/utils.ts
```typescript
import {
	OPT_CHAIN,
	CONFIG,
	POOLS,
	type ChainType,
	type SupportedToken,
	type WalletBalances,
	WATCH_ADDRESS
} from "../config.js";
import {ethers, formatUnits} from 'ethers';
⋮----
/**
 * Универсальная обертка для повторных попыток выполнения асинхронных функций
 * @param fn - Функция, которую нужно выполнить
 * @param retries - Количество попыток (по умолчанию 3)
 * @param delay - Начальная задержка в мс (по умолчанию 1000)
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    retries: number = 3,
    delay: number = 1000
): Promise<T>
⋮----
// Проверяем, является ли ошибка временным сбоем (таймаут, лимиты, сетевой сбой)
⋮----
// Экспоненциальное увеличение задержки (1s -> 2s -> 4s)
⋮----
// Если попытки кончились или ошибка критическая — выбрасываем её дальше
⋮----
/**
 * Возвращает стоимость ETH в OP (эфир в оптимизмах)
 *
 * @param pool
 * @param provider
 */
export async function getUniswapPoolPrice(
    chain: ChainType,
    pool: string,
    provider: ethers.JsonRpcProvider
)
⋮----
// Получаем текущий слепок пула (без затрат газа)
⋮----
// Математика Uniswap V3 для расчета цены из tick
// Цена ETH относительно OP = 1.0001 ^ tick
⋮----
export async function estimatePriceImpact(
    provider: ethers.JsonRpcProvider,
    amountInHuman: number, // Сколько OP мы хотим поменять (например, 1000)
    poolAddress: string,
    abi: string[],
)
⋮----
amountInHuman: number, // Сколько OP мы хотим поменять (например, 1000)
⋮----
// 1. ПОЛУЧЕНИЕ ИСХОДНЫХ ДАННЫХ ПУЛА
⋮----
// Считаем стандартный L2 Execution Fee
⋮----
const L2_GAS_LIMIT = BigInt(150000); // Оценка лимита газа исполнения на L2
⋮----
// Суммарный газ (L1 + L2)
⋮----
// 3. МАТЕМАТИКА СВОПА И ПОТЕРЬ
⋮----
// Идеальный результат без издержек
⋮----
// Переводим стоимость газа из ETH в OP по текущему курсу для сложения
⋮----
// Рассчитываем движение цены
⋮----
// Итоговый чистый профит на кошельке
⋮----
// Финансовые потери пула
⋮----
// ИТОГО (Пул + Реальный Газ L1 + L2)
⋮----
async function l1FeeEstimated(provider: ethers.JsonRpcProvider)
⋮----
// 2. СОВРЕМЕННЫЙ АВТОНОМНЫЙ РАСЧЕТ ГАЗА OPT (L1 Ecotone + L2)
⋮----
const oracleDecimals = await oracleContract.decimals(); // Обычно 6
⋮----
// Приблизительный объем calldata газа для Swap-транзакции exactInputSingle (~300 байт)
const calldataGas = BigInt(4200 * 2); // берем с 2х запасом
⋮----
// Актуальная формула расчета L1 Data Fee (Bedrock/Ecotone с BlobSpace)
// Формула: calldataGas * (16 * l1BaseFee * baseFeeScalar + blobBaseFee * blobBaseFeeScalar) / (16 * 10^decimals)
⋮----
export async function getWalletBalances(
    chain: ChainType,
    provider: ethers.JsonRpcProvider
): Promise<WalletBalances>
⋮----
// 1. СНАЧАЛА ПОЛУЧАЕМ БАЛАНС НАТИВНОГО ETH
// Нативный баланс запрашивается напрямую через провайдер, а не через контракт
⋮----
// 2. ПОЛУЧАЕМ БАЛАНСЫ ОСТАЛЬНЫХ ERC-20 ТОКЕНОВ ИЗ КОНФИГА
// Перебираем токены, которые описаны в CONFIG.TOKEN_DECIMALS (например, USDC, OP, WETH, cbBTC)
⋮----
// Пропускаем ETH, так как нативный баланс мы уже получили выше
⋮----
// Берем адрес контракта токена из конфигурации вашей текущей сети
⋮----
// ЗДЕСЬ ДОБАВЛЯЕМ ПРОВЕРКУ-ЗАЩИТУ:
⋮----
continue; // Пропускаем токен, если его адреса нет в этой сети
⋮----
// Запрашиваем баланс токена на кошельке
//const balanceWei = await withRetry<bigint>(() => (tokenContract as any).balanceOf(WATCH_ADDRESS));
⋮----
// Используем decimals из глобального конфига
⋮----
// Выводим в консоль только ненулевые балансы, чтобы не спамить
⋮----
async function getTokenBalanceWei(
    chain: ChainType,
    provider: ethers.JsonRpcProvider,
    tokenSymbol: SupportedToken
)
⋮----
// ДОБАВЛЯЕМ ПРАВИЛЬНУЮ ПРОВЕРКУ-ЗАЩИТУ ДЛЯ ФУНКЦИИ:
⋮----
return 0n; // Возвращаем нулевой баланс (BigInt), если адреса нет в сети
⋮----
// Запрашиваем баланс токена на кошельке
⋮----
async function getTokenBalanceHuman(
    chain: ChainType,
    provider: ethers.JsonRpcProvider,
    tokenSymbol: SupportedToken
)
⋮----
// Используем decimals из глобального конфига
⋮----
/**
 * Вычисляет точную стоимость газа транзакции в ETH (L1 + L2) на основе квитанции
 */
export function calculateTxGasCost(receipt: ethers.TransactionReceipt): number
⋮----
// 1. Считаем L2 Execution Fee
⋮----
// 2. Считаем L1 Data Fee (специфично для OPT/BASE)
// В ethers.js v6 свойство l1Fee может лежать в сырых данных квитанции
⋮----
// 3. Суммируем и переводим в человеческий ETH
⋮----
export async function reportGasSpent(receipt: ethers.TransactionReceipt): Promise<void>
⋮----
export async function reportErrorGasSpent(err: any): Promise<void>
⋮----
export function sleep(ms: number): Promise<null>
```

## File: moonwellUtils.ts
```typescript
import {CONFIG, type ChainType} from "./config.js";
import {ethers} from 'ethers';
import {withRetry} from "./utils/utils.js";
⋮----
export interface MTokensCache {
    [symbol: string]: string;
}
⋮----
// Вызывается один раз при старте бота
export async function initializeMTokensCache(
    chain: ChainType,
    provider: ethers.JsonRpcProvider
): Promise<MTokensCache>
⋮----
// Получаем все рынки из блокчейна один раз
⋮----
// Из 'mUSDC' получаем 'USDC', из 'mcbBTC' получаем 'cbBTC'
```

## File: config.ts
```typescript
import {ethers, getAddress} from 'ethers';
⋮----
// Функция-помощник для проверки обязательных переменных
export const getEnv = (key: string): string =>
⋮----
// Задаем список всех поддерживаемых токенов
export type SupportedToken = 'USDC' | 'OP' | 'ETH' | 'WETH' | 'cbBTC' | 'MAMO' | 'WELL';
⋮----
// Описываем структуру для токенов в конкретной сети
type TokenList = {
    [K in SupportedToken]?: string;
};
⋮----
// Создаем список сетей в рантайме
⋮----
export type ChainType = typeof CHAIN_NAMES[number];
⋮----
// Описываем структуру Moonwell
interface MoonwellConfig {
    COMPTROLLER: string;
}
⋮----
// Общий интерфейс для настроек конкретной сети
interface NetworkSettings {
    ID: string;
    RPC_URL: string;
    TOKENS: TokenList;
    MOONWELL?: MoonwellConfig;
}
⋮----
// Типизируем весь конфиг
interface AppConfig {
    TOKEN_DECIMALS:
    // Делаем все токены из списка необязательными (через знак ?)
        { [K in SupportedToken]?: number } &
        // И жестко требуем наличие поля default
        { default: number } &
        // Разрешаем ЛЮБОЙ другой строковый ключ со значением number
        { [key: string]: number };
    ZEROX_API_KEY: string;
    NETWORKS: {
        [key in ChainType]: NetworkSettings;
    };
    ABI: {
        MOONWELL: string[];
        UNISWAP: string[];
        ORACLE: string[];
        UNISWAP_ROUTER: string[];
        ERC20_BALANCE_ABI: string[];
        MORPHO: string[];
    };
}
⋮----
// Делаем все токены из списка необязательными (через знак ?)
⋮----
// И жестко требуем наличие поля default
⋮----
// Разрешаем ЛЮБОЙ другой строковый ключ со значением number
⋮----
RPC_URL: "https://optimism.drpc.org", //getEnv('OPTIMISM_RPC_URL'),
⋮----
RPC_URL: 'https://mainnet.base.org', //https://base-rpc.publicnode.com',// getEnv('BASE_RPC_URL'),
⋮----
// Добавляем ABI для самих mToken контрактов
⋮----
"function borrow(uint256 borrowAmount) external", // borrow
"function repayBorrow(uint256 repayAmount) external returns (uint256)", // repay
"function getCash() view returns (uint256)", // Метод получения свободной ликвидности пула
⋮----
// Нам нужен стандартный минимальный ABI для работы с ERC-20 токенами
⋮----
// Параметры для API
⋮----
EthOp005: "0xFC1f3296458F9b2a27a0B91dd7681C4020E09D05", // Пул 0.05%
EthOp03: "0x68F5C0A2DE713a54991E01858Fd27a3832401849", // Пул 0.3%
OracleAddress: "0x420000000000000000000000000000000000000F", // Optimism GasPriceOracle
⋮----
// Настройки
⋮----
export function getMoonwellMarkets(chain: ChainType)
⋮----
export interface WalletBalances {
    [tokenSymbol: string]: {
        wei: bigint;
        human: number;
    };
}
```

## File: index.ts
```typescript
import {BASE_CHAIN, CHAIN_NAMES, CONFIG, OPT_CHAIN, type ChainType, type WalletBalances} from './config.js'; // Важно: в ESM нужно указывать .js
import {getWalletBalances, sleep} from './utils/utils.js';
import {initializeWallet, wallet} from "./utils/loadWallet.js";
import {MoonwellPosition} from "./classes/MoonwellPosition.js";
import {MorphoPosition} from "./classes/MorphoPosition.js";
import {HLPosition} from "./classes/HLPosition.js";
import {FetchRequest, ethers} from "ethers";
⋮----
function getProvider(chain: ChainType): ethers.JsonRpcProvider
⋮----
// Глобальный перехватчик неисполненных промисов
⋮----
// Проверяем, что это именно таймаут от Ethers.js
⋮----
return; // Просто гасим ошибку, не давая процессу упасть
⋮----
// Если это какая-то другая серьезная ошибка, лучше вывести её в логи
⋮----
async function main()
⋮----
let borrowAmount = 0; // подлупка в токенах займа (OP)
let supplyAmount = 0; // разлупка в токенах займа (OP)
⋮----
// Получаем слепок всех балансов на кошельке
⋮----
// await getMoonwellData(); // Общий статус, сколько можно занять в USD
//await getJumperQuote();
//await get0xQuoteV2("1.0");
//await getUniswapPoolPrice(chain, POOLS.OPT.EthOp03, activeProvider);
//await getUniswapPoolPrice(chain, POOLS.OPT.EthOp005, activeProvider);
//await estimatePriceImpact(activeProvider, borrowAmount, POOLS.OPT.EthOp03, CONFIG.ABI.UNISWAP);
//await estimatePriceImpact(activeProvider, borrowAmount, POOLS.OPT.EthOp005, CONFIG.ABI.UNISWAP);
```
