using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebScrape.Data.Migrations
{
    /// <inheritdoc />
    public partial class M2_7DropLegacyScraperConfigId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "fk_tasks_scraper_configs_scraper_config_id",
                table: "tasks");

            migrationBuilder.DropIndex(
                name: "ix_tasks_scraper_config_id",
                table: "tasks");

            migrationBuilder.DropColumn(
                name: "scraper_config_id",
                table: "tasks");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "scraper_config_id",
                table: "tasks",
                type: "uuid",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "ix_tasks_scraper_config_id",
                table: "tasks",
                column: "scraper_config_id");

            migrationBuilder.AddForeignKey(
                name: "fk_tasks_scraper_configs_scraper_config_id",
                table: "tasks",
                column: "scraper_config_id",
                principalTable: "scraper_configs",
                principalColumn: "id",
                onDelete: ReferentialAction.Restrict);
        }
    }
}
