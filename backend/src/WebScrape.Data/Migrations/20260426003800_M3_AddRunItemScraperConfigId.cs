using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebScrape.Data.Migrations
{
    /// <inheritdoc />
    public partial class M3_AddRunItemScraperConfigId : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "scraper_config_id",
                table: "run_items",
                type: "uuid",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "scraper_config_id",
                table: "run_items");
        }
    }
}
