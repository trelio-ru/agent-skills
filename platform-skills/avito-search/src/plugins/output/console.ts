/**
 * Console output plugin
 */

import Table from 'cli-table3';
import chalk from 'chalk';
import type { SearchResult, ItemDetails } from '../../core/types.js';

/** Provider text is untrusted even in a terminal. Strip ANSI/OSC controls
 * before chalk adds its own formatting; retain ordinary newlines and tabs. */
function safeTerminal<T>(value:T):T {
  if(typeof value==='string')return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu,'')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu,'') as T;
  if(Array.isArray(value))return value.map(child=>safeTerminal(child)) as T;
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,safeTerminal(child)])) as T;
  return value;
}

export class ConsoleOutput {
  /**
   * Display search results as table
   */
  displayResults(results: SearchResult[]): void {
    results=safeTerminal(results);
    if (results.length === 0) {
      console.log(chalk.yellow('Ничего не найдено'));
      return;
    }

    const table = new Table({
      head: [
        chalk.cyan('ID'),
        chalk.cyan('Название'),
        chalk.cyan('Цена'),
        chalk.cyan('Местоположение'),
        chalk.cyan('URL'),
      ],
      colWidths: [12, 50, 12, 20, 50],
      wordWrap: true,
    });

    results.forEach((item) => {
      table.push([
        item.id,
        item.title,
        chalk.green(item.priceText || (item.price === null ? 'Цена не указана' : `${item.price} ₽`)),
        item.location,
        chalk.blue(item.url),
      ]);
    });

    console.log(table.toString());
    console.log(chalk.bold(`\nВсего: ${results.length} объявлений`));
  }

  /**
   * Display item details
   */
  displayDetails(details: ItemDetails): void {
    details=safeTerminal(details);
    console.log(chalk.bold.cyan('\n=== Детали объявления ===\n'));

    console.log(chalk.bold('Название:'), details.title);
    console.log(chalk.bold('Цена:'), chalk.green(details.priceText || (details.price === null ? 'Цена не указана' : `${details.price} ₽`)));
    console.log(chalk.bold('Местоположение:'), details.location);
    console.log(chalk.bold('URL:'), chalk.blue(details.url));

    if (details.seller) {
      console.log(chalk.bold('\nПродавец:'), details.seller.name);
    }

    if (details.viewsCount) {
      console.log(chalk.bold('Просмотры:'), details.viewsCount);
    }

    console.log(chalk.bold('\nОписание:'));
    console.log(details.fullDescription);

    if (details.images && details.images.length > 0) {
      console.log(chalk.bold(`\nИзображения (${details.images.length}):`));
      details.images.slice(0, 5).forEach((img, i) => {
        console.log(`  ${i + 1}. ${chalk.blue(img)}`);
      });
      if (details.images.length > 5) {
        console.log(chalk.gray(`  ... и ещё ${details.images.length - 5}`));
      }
    }

    if (details.specifications) {
      console.log(chalk.bold('\nХарактеристики:'));
      Object.entries(details.specifications).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    }
  }

  /**
   * Display error
   */
  displayError(error: Error): void {
    console.error(chalk.red.bold('Ошибка:'), error.message);

  }

  /**
   * Display success message
   */
  displaySuccess(message: string): void {
    console.log(chalk.green('✓'), message);
  }

  /**
   * Display info message
   */
  displayInfo(message: string): void {
    console.log(chalk.blue('ℹ'), message);
  }
}
