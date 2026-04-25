using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace WebScrape.Data.Migrations
{
    /// <inheritdoc />
    public partial class M2RunItemStatusEnum : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Translate existing lowercase status values to the PascalCase form that
            // EF's HasConversion<string>() now writes (matches the C# enum names).
            migrationBuilder.Sql("""
                UPDATE run_items SET status = CASE status
                    WHEN 'pending'   THEN 'Pending'
                    WHEN 'sent'      THEN 'Sent'
                    WHEN 'running'   THEN 'Running'
                    WHEN 'paused'    THEN 'Paused'
                    WHEN 'completed' THEN 'Completed'
                    WHEN 'failed'    THEN 'Failed'
                    WHEN 'cancelled' THEN 'Cancelled'
                    ELSE status
                END;
            """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE run_items SET status = CASE status
                    WHEN 'Pending'   THEN 'pending'
                    WHEN 'Sent'      THEN 'sent'
                    WHEN 'Running'   THEN 'running'
                    WHEN 'Paused'    THEN 'paused'
                    WHEN 'Completed' THEN 'completed'
                    WHEN 'Failed'    THEN 'failed'
                    WHEN 'Cancelled' THEN 'cancelled'
                    ELSE status
                END;
            """);
        }
    }
}
