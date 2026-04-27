using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebScrape.Data.Migrations
{
    /// <inheritdoc />
    public partial class M5ConfigSync : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "ix_scraper_configs_user_id",
                table: "scraper_configs");

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "last_synced_at",
                table: "scraper_configs",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "origin_client_id",
                table: "scraper_configs",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "shared",
                table: "scraper_configs",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.CreateTable(
                name: "scraper_config_subscriptions",
                columns: table => new
                {
                    scraper_config_id = table.Column<Guid>(type: "uuid", nullable: false),
                    worker_id = table.Column<Guid>(type: "uuid", nullable: false),
                    last_pulled_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_scraper_config_subscriptions", x => new { x.scraper_config_id, x.worker_id });
                    table.ForeignKey(
                        name: "fk_scraper_config_subscriptions_scraper_configs_scraper_config",
                        column: x => x.scraper_config_id,
                        principalTable: "scraper_configs",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_scraper_config_subscriptions_worker_connections_worker_id",
                        column: x => x.worker_id,
                        principalTable: "worker_connections",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "ix_scraper_configs_user_id_shared",
                table: "scraper_configs",
                columns: new[] { "user_id", "shared" });

            migrationBuilder.CreateIndex(
                name: "ix_scraper_config_subscriptions_worker_id",
                table: "scraper_config_subscriptions",
                column: "worker_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "scraper_config_subscriptions");

            migrationBuilder.DropIndex(
                name: "ix_scraper_configs_user_id_shared",
                table: "scraper_configs");

            migrationBuilder.DropColumn(
                name: "last_synced_at",
                table: "scraper_configs");

            migrationBuilder.DropColumn(
                name: "origin_client_id",
                table: "scraper_configs");

            migrationBuilder.DropColumn(
                name: "shared",
                table: "scraper_configs");

            migrationBuilder.CreateIndex(
                name: "ix_scraper_configs_user_id",
                table: "scraper_configs",
                column: "user_id");
        }
    }
}
