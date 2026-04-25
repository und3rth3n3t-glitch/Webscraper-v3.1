using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebScrape.Data.Migrations
{
    /// <inheritdoc />
    public partial class M2TaskBlocks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // 1. Create new tables
            migrationBuilder.CreateTable(
                name: "task_blocks",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    task_id = table.Column<Guid>(type: "uuid", nullable: false),
                    parent_block_id = table.Column<Guid>(type: "uuid", nullable: true),
                    block_type = table.Column<string>(type: "text", nullable: false),
                    order_index = table.Column<int>(type: "integer", nullable: false),
                    config_jsonb = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_task_blocks", x => x.id);
                    table.ForeignKey(
                        name: "fk_task_blocks_tasks_task_id",
                        column: x => x.task_id,
                        principalTable: "tasks",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_task_blocks_task_blocks_parent_block_id",
                        column: x => x.parent_block_id,
                        principalTable: "task_blocks",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "run_batches",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    task_id = table.Column<Guid>(type: "uuid", nullable: false),
                    user_id = table.Column<Guid>(type: "uuid", nullable: false),
                    worker_id = table.Column<Guid>(type: "uuid", nullable: false),
                    populate_snapshot = table.Column<string>(type: "jsonb", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("pk_run_batches", x => x.id);
                    table.ForeignKey(
                        name: "fk_run_batches_tasks_task_id",
                        column: x => x.task_id,
                        principalTable: "tasks",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_run_batches_users_user_id",
                        column: x => x.user_id,
                        principalTable: "AspNetUsers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "fk_run_batches_worker_connections_worker_id",
                        column: x => x.worker_id,
                        principalTable: "worker_connections",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                });

            // 2. Add nullable columns to run_items
            migrationBuilder.AddColumn<Guid>(
                name: "batch_id",
                table: "run_items",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "iteration_label",
                table: "run_items",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "iteration_assignments",
                table: "run_items",
                type: "jsonb",
                nullable: true);

            migrationBuilder.AddForeignKey(
                name: "fk_run_items_run_batches_batch_id",
                table: "run_items",
                column: "batch_id",
                principalTable: "run_batches",
                principalColumn: "id",
                onDelete: ReferentialAction.SetNull);

            // 3. Indexes
            migrationBuilder.CreateIndex(
                name: "ix_task_blocks_task_id_parent_block_id_order_index",
                table: "task_blocks",
                columns: new[] { "task_id", "parent_block_id", "order_index" });

            migrationBuilder.CreateIndex(
                name: "ix_task_blocks_parent_block_id",
                table: "task_blocks",
                column: "parent_block_id");

            migrationBuilder.CreateIndex(
                name: "ix_run_batches_task_id",
                table: "run_batches",
                column: "task_id");

            migrationBuilder.CreateIndex(
                name: "ix_run_batches_user_id",
                table: "run_batches",
                column: "user_id");

            migrationBuilder.CreateIndex(
                name: "ix_run_batches_worker_id",
                table: "run_batches",
                column: "worker_id");

            migrationBuilder.CreateIndex(
                name: "ix_run_items_batch_id",
                table: "run_items",
                column: "batch_id");

            // 4. Backfill existing tasks as 1-loop-1-scrape trees BEFORE dropping search_terms.
            //    Uses gen_random_uuid() (built into PostgreSQL 13+; no extension needed).
            //    Two CTEs so the scrape rows can reference the just-inserted loop rows.
            migrationBuilder.Sql("""
                WITH inserted_loops AS (
                    INSERT INTO task_blocks (id, task_id, parent_block_id, block_type, order_index, config_jsonb)
                    SELECT
                        gen_random_uuid(),
                        t.id,
                        NULL,
                        'Loop',
                        0,
                        jsonb_build_object('name', 'loop1', 'values', to_jsonb(COALESCE(t.search_terms, ARRAY[]::text[])))
                    FROM tasks t
                    RETURNING id, task_id
                )
                INSERT INTO task_blocks (id, task_id, parent_block_id, block_type, order_index, config_jsonb)
                SELECT
                    gen_random_uuid(),
                    t.id,
                    il.id,
                    'Scrape',
                    0,
                    jsonb_build_object('scraperConfigId', t.scraper_config_id::text, 'stepBindings', '{}'::jsonb)
                FROM tasks t
                JOIN inserted_loops il ON il.task_id = t.id;
            """);

            // 5. Drop the now-migrated column
            migrationBuilder.DropColumn(
                name: "search_terms",
                table: "tasks");

            // 6. Make scraper_config_id nullable (deprecated; M5 will drop the column entirely).
            //    The FK + ix_tasks_scraper_config_id index stay in place.
            migrationBuilder.AlterColumn<Guid>(
                name: "scraper_config_id",
                table: "tasks",
                type: "uuid",
                nullable: true,
                oldClrType: typeof(Guid),
                oldType: "uuid");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Reverse: tighten scraper_config_id, restore search_terms (empty), drop FKs/indexes/tables.
            migrationBuilder.AlterColumn<Guid>(
                name: "scraper_config_id",
                table: "tasks",
                type: "uuid",
                nullable: false,
                defaultValue: Guid.Empty,
                oldClrType: typeof(Guid),
                oldType: "uuid",
                oldNullable: true);

            migrationBuilder.AddColumn<string[]>(
                name: "search_terms",
                table: "tasks",
                type: "text[]",
                nullable: false,
                defaultValueSql: "ARRAY[]::text[]");

            migrationBuilder.DropForeignKey(name: "fk_run_items_run_batches_batch_id", table: "run_items");
            migrationBuilder.DropIndex(name: "ix_run_items_batch_id", table: "run_items");
            migrationBuilder.DropColumn(name: "iteration_assignments", table: "run_items");
            migrationBuilder.DropColumn(name: "iteration_label", table: "run_items");
            migrationBuilder.DropColumn(name: "batch_id", table: "run_items");

            migrationBuilder.DropTable(name: "run_batches");
            migrationBuilder.DropTable(name: "task_blocks");
        }
    }
}
